# 5. MCP 外部工具协议与智能检索

> [English documentation](../docs/mcp-integration.md)

Model Context Protocol（MCP）是开放的工具集成协议。AgentBox 使用官方 TypeScript SDK 管理 MCP Client 生命周期，并在 Gateway 中完成服务器白名单、工具检索、参数校验、用户审批和多轮执行。

---

## 传输与连接生命周期

```text
+--------------------------------------------------------------------+
|                         ChatGateway                                |
|          Tool selection / approval / multi-turn execution          |
+--------------------------------------------------------------------+
                                  |
                                  v
+--------------------------------------------------------------------+
|                         McpManager                                 |
|          Client pool / paginated listing / aggregation             |
+--------------------------------------------------------------------+
                   |                                  |
                   v                                  v
+------------------------------------+  +----------------------------+
| Official StdioClientTransport      |  | Remote HTTP transports     |
| child process + JSON-RPC            |  | Streamable HTTP / 旧式 HTTP+SSE|
+------------------------------------+  +----------------------------+
```

配置值与实际行为如下：

| 配置值  | SDK Transport                   | 行为                                                              |
| ------- | ------------------------------- | ----------------------------------------------------------------- |
| `stdio` | `StdioClientTransport`          | 启动本地命令，通过 stdin/stdout 交换 JSON-RPC。                   |
| `http`  | `StreamableHTTPClientTransport` | 优先使用当前的 Streamable HTTP；连接失败时自动尝试旧式 HTTP+SSE。 |
| `sse`   | `SSEClientTransport`            | 显式使用旧式 HTTP+SSE，不先尝试 Streamable HTTP。                 |

- Stdio 子进程使用 SDK 的默认安全环境变量集合，再叠加该 MCP Server 的自定义环境变量；单条缓冲消息上限为 10 MiB。
- Streamable HTTP 配置了有限重连（初始 500 ms、最大 10 s、最多 3 次），会话 ID、协议版本头和 SSE 数据流由 SDK 处理。
- HTTP 远程地址必须使用 HTTPS；仅本机回环地址允许 HTTP。保存时会移除 URL 中的用户信息、查询参数和 fragment，认证信息应放入自定义请求头。
- Stdio 环境变量和远程请求头保存在加密 Vault 中；返回 Renderer 的配置只包含同名遮罩值。请求头会拒绝 `Host`、`Content-Length`、Cookie 和代理认证等受控字段。
- 远程 MCP 请求遵循应用的自定义网络代理设置。
- [`McpManager`](../src/electron/mcp/mcp-manager.ts) 复用配置未变化的 Client，并以最高 8 个 Server 的并发度聚合工具。工具列表每页 30 秒超时，每个 Server 最多读取 64 页、2,000 个工具；收到工具列表变更通知时当前实现记录日志，下一次列举会重新获取列表。

连接实现见 [`src/electron/mcp/mcp-client.ts`](../src/electron/mcp/mcp-client.ts)。

---

## BM25 工具检索与会话白名单

[`src/electron/mcp/tool-retriever.ts`](../src/electron/mcp/tool-retriever.ts) 会把工具名、Server 名称、描述、参数名和参数描述组成检索文档，并对中英文词项进行 BM25 评分：

- **智能检索（`auto`）**：Gateway 使用当前最后一条用户消息作为查询，注入分数达到 0.75 的前 8 个 MCP 工具；工具全名和名称片段命中会获得额外权重。没有合格结果时不会任意补齐。
- **全部挂载（`all`）**：注入会话允许的全部 MCP 工具，不做相关度过滤。
- 动态 Agent 工具挂载关闭时（兼容性默认），上述检索只作用于外部 MCP 工具。`agentbox_load_skill`、代码运行器、工作区文件工具和集成终端等内置 Agent 工具会按可用条件追加，不参与 BM25 排名。
- 动态挂载开启时，同一排名会作用于本次请求已授权的完整内置/MCP 联合目录，初始上限默认为 4 个工具。始终挂载的只读后备工具 `agentbox_search_tools` 仅搜索该已授权目录，并在下一模型轮次挂载匹配项；它不会执行匹配工具。模型调用开始时会快照当前工具集，因此搜索调用不能授权同一模型响应中的第二个调用。

每个会话通过 `mcpServerIds` 建立 Server 白名单：

- 字段未设置时，可聚合所有全局启用的 MCP Server。
- 空数组表示不允许任何 MCP Server。
- 非空数组只允许其中仍处于全局启用状态的 Server；失效或停用的 ID 不会产生工具。

为了避免名称碰撞和伪造调用，模型看到的是带 Server/工具哈希的 64 字符以内安全别名。执行器只接受本轮确实暴露过的别名，再路由回原始 Server ID 与工具名。

---

## Agent 多轮执行循环

```mermaid
sequenceDiagram
    participant User as Renderer
    participant GW as ChatGateway
    participant Model as Model API
    participant MCP as McpManager

    User->>GW: Agent 请求 + Server 白名单
    GW->>Model: System Instructions + 已选工具定义
    Model-->>GW: tool_call / function_call / tool_use
    GW->>User: 工具卡片与必要的审批请求
    GW->>MCP: 校验后执行工具
    MCP-->>GW: 文本、结构化或多媒体结果
    GW->>User: tool-result
    GW->>Model: 追加结果并开始下一轮
    Model-->>GW: 最终文本
    GW->>User: text-delta + done
```

- Gateway 在 OpenAI Chat Completions API 的 `tool_calls`、OpenAI Responses API 的 `function_call` 与 Anthropic Messages API 的 `tool_use` 之间桥接协议格式。
- 请求级 LangGraph Runtime 控制 model/tool/终态转换；参数校验、审批、执行、事件发送与 provider 历史构造仍位于 Gateway 回调中。
- Agent 工具执行上限默认 30 轮，可在设置中调整为 1–100；达到上限后，本轮尚未执行的调用会收到错误结果。
- `agentTrace` 是按发生顺序保存的协议无关账本，包含模型文本/思考块、工具调用、工具结果及必要的 provider item，可用于后续协议重放。
- 带 renderer response ID 的 Agent 请求还会写入加密 LangGraph checkpoint thread。只有 provider-node 失败会直接恢复该 thread；取消和副作用不确定的工具路径使用 `agentTrace` 中的已完成/错误结果重启，避免重复写入或执行。
- 限流、网络/API 错误、输出上限、工具轮次上限或用户停止会生成 `interruption` 检查点。恢复时复用已完成结果；对结果未知且可能有副作用的操作，应先检查外部状态再决定是否重试。
- 只有当前分支最后一条 Assistant 消息存在检查点时，`go`、`continue`、`resume`、`retry`、`继续` 等短指令才会作为恢复请求；附件或新的实质要求仍按新问题处理。

---

## 审批策略与执行边界

所有工具调用都先解析 JSON，并通过工具的 input JSON Schema 校验。非法 JSON、Schema 不匹配、未知工具以及本轮未暴露的工具都不会执行。

### 审批模式

| 设置                              | 实际行为                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **智能确认（`sensitive`，默认）** | 只有同时声明 `readOnlyHint: true`、`destructiveHint: false`、`openWorldHint: false` 的工具可自动执行；其余工具需要审批。 |
| **每次确认（`always`）**          | 所有代码、终端、工作区和 MCP 调用都需要审批。本地目录/结果/Skill 资源读取器不产生副作用，因此无需审批。                  |
| **Full Access（`full-access`）**  | 跳过代码运行器、终端、工作区文件和外部 MCP 工具的审批。它不会放宽路径、Schema、超时或结果大小校验。                      |

内置工具还有以下固定规则：

- `agentbox_load_skill` 只加载已启用技能的本地文档，不执行脚本，因此直接完成且不弹出审批。
- `agentbox_search_tools`、`agentbox_read_tool_result` 和 `agentbox_read_skill_resource` 只检查本次请求已授权的内存或本地数据。它们绝不执行搜索到的工具或 Skill 脚本，也不会弹出审批。
- `agentbox_run_code` 和 `agentbox_run_terminal` 始终按敏感操作处理；除 Full Access 外都需要用户批准。
- `agentbox_read_file` 带有完整的只读、非破坏、封闭环境声明，因此在默认策略下可自动执行；`agentbox_write_file` 是破坏性写入，需要审批。
- 外部 MCP Server 的 `ToolAnnotations` 是 Server 自行声明的数据；缺少任意一项完整低风险声明时，默认按敏感工具处理。

审批默认等待 5 分钟，也可设置为永不超时。等待审批时，120 秒网络停滞计时器会暂停；用户拒绝、停止请求或请求生命周期结束都会终止等待。Full Access 只适用于完全可信的模型、MCP Server 和任务。

### 资源与数据边界

- MCP `callTool` 超时为 60 秒并接受请求取消信号。
- MCP 文本/结构化结果最多保留约 100,000 字符；图片、音频和二进制 Resource 的 base64 数据各自限制为 2 MiB，超限内容会省略或标记截断。
- `agentbox_read_file` / `agentbox_write_file` 拒绝绝对路径、`..`、UNC 路径和工作目录内的符号链接。读取仅接受 2 MiB 以内的 UTF-8 普通文件；单次写入同时受 100,000 字符和 512 KiB 限制。
- 工具描述、参数、返回内容和外部 Resource 都按不可信数据处理；它们不能覆盖更高优先级指令。
- 集成终端只有初始 `cwd`，不是操作系统沙箱。获批命令仍可能使用绝对路径、访问工作目录外文件、启动进程或联网，详见[会话工作目录与开发运行时](workspaces-and-runtimes.md)。

---

## UI 与诊断

1. **设置 → MCP 外部工具**：创建、启停和测试 stdio、Streamable HTTP 或旧式 HTTP+SSE 配置；测试结果会显示实际协商成功的 Transport、协议版本和工具数量。
2. **Tool Explorer**：汇总已启用的 MCP 工具和 AgentBox 内置工具，可按来源筛选并查看 input Schema。工作区文件工具会出现在目录中，但只在具有工作目录的 Agent 会话中实际挂载。
3. **Composer 白名单**：选择当前会话允许的 MCP Server。
4. **工具卡片**：显示等待审批、执行中、完成、拒绝或错误状态，以及参数和截断后的结果。
5. **中断恢复**：可以从检查点继续，也可以从原用户问题重新生成；两者的副作用语义不同。
