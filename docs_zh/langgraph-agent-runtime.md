# LangGraph Agent Runtime

> English: [LangGraph Agent Runtime](../docs/langgraph-agent-runtime.md)

AgentBox 使用请求级 LangGraph `StateGraph` 控制多轮 Agent 生命周期。Runtime 是 Electron 主进程内的编排组件，不替换 AgentBox 的 provider 适配器、MCP Client、工具安全策略、加密 repository 或 renderer 事件模型。

## 职责

Runtime 只管理状态转换：

```text
START -> model -> tools -> model -> ... -> terminal -> END
                   |                     |
                   +-- tool limit -------+
```

`ChatGateway` 仍是请求与安全外壳。它向图提供 provider 请求、SSE 消费、工具校验与审批、内置/MCP 工具执行、上下文裁剪和现有 `StreamEvent` 发送回调。

| 组件                 | 职责                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------- |
| `ChatGateway`        | 请求校验、provider/model 解析、代理调度、网络看门狗、错误脱敏、审批等待和回调组装       |
| `runAgentRuntime()`  | model/tool/终态路由、轮次计数、递归上限、取消传播和可选 checkpoint 恢复                 |
| 请求/协议适配器      | OpenAI Chat Completions API、OpenAI Responses API 和 Anthropic Messages API wire format |
| 工具执行器           | AJV 校验、审批策略、工作区限制、MCP 路由、代码/终端执行和结果限制                       |
| Renderer stream hook | 把归一化事件投影到 Assistant 文本、reasoning、引用、工具、`agentTrace` 和 interruption  |

## Runtime 状态

图使用 provider-neutral 的 AgentBox 消息，而不是 LangChain message class。

| 状态字段         | 含义                                                                    |
| ---------------- | ----------------------------------------------------------------------- |
| `messages`       | 为下一 provider 请求准备的上下文                                        |
| `turn`           | 当前运行已进入 model node 的次数                                        |
| `toolTurns`      | 请求工具并已进入处理的模型响应数                                        |
| `modelResult`    | 最新 provider stream 的归一化结果，包含 tool call 与回放数据            |
| `terminal`       | 终态回调是否完成                                                        |
| `terminalReason` | `complete`、`output_limit`、`unexpected_tool_call` 或 `tool_turn_limit` |

一个 provider 响应即使包含多个 tool call，也只消耗一个 tool turn。调用继续按 provider 顺序处理，保持审批顺序和副作用行为。

## 转换规则

每个 model node 完成后，图选择一条路径：

- 输出上限结束原因（`length`、`max_tokens`、`max_output_tokens` 或 `incomplete`）：以 `output_limit` 终止并保留 checkpoint；
- 无 tool call：执行正常完成处理器；
- 非 Agent 模式下的 tool call：不执行并以 `unexpected_tool_call` 终止；
- 已达工具上限：为每个未执行调用发送错误结果，并以 `tool_turn_limit` 终止；
- 有效 Agent tool turn：执行工具回调，追加 Assistant/工具历史，再回到 model node。

图递归上限根据配置的 tool-turn 上限计算。当前产品范围是 1–100，默认 30。

开启可选的单次运行内上下文压缩后，当模型可见输入越过软阈值时，Gateway 会把最新用户消息之后较早且已完成的整个工具轮次消息替换为确定性的普通 Assistant 摘要。配置要保留的近期轮次与所有未完成调用保持原样，因此协议适配器绝不会收到孤立的工具调用或结果。进入下一图状态和 checkpoint 的是优化后消息，而不是 renderer 事件 payload。

## Streaming 与取消

Provider streaming 仍位于 `ChatGateway`。在 model node 运行期间，文本、reasoning、引用、用量、provider item 和工具参数 delta 会立即发送；LangGraph 只在图边界保存 checkpoint。

每个 usage 事件都会标注当前模型轮次。Renderer 会合并同轮的分段事件并保留逐请求明细，因此可以对完整 `model -> tools -> model` 运行的消息级用量求和。

同一请求级 `AbortSignal` 传给图和所有回调，用于取消 provider fetch、MCP、代码、终端、工作区和审批等待。120 秒网络停滞定时器只在等待 provider 数据时运行，工具处理期间暂停。

内置浏览器导航、截图、上传和下载都使用同一个 signal。已取消的请求不能开始这些操作；进行中的 Agent 下载会在可行时取消，且会话队列会等待进行中的原生浏览器工作结束后才启动后续操作。在取消前瞬间已派发的 CDP 文件选择仍可能留下不确定的外部页面状态，因此恢复后的 Agent 在重试任何中断的浏览器副作用前必须先检查状态。活动多标签 `WebContentsView` 会话属于对话，而不是 graph state。Checkpoint 和 `agentTrace` 只保存脱敏调用以及已完成的语义/截图结果，不保存标签状态、Cookie 值、DOM 引用、进行中的下载或导航状态。可选 Cookie 持久化使用独立加密 Vault profile，绝不进入 graph state。应用重启或浏览器会话被回收后，Agent 必须重新列出/创建标签并检查页面；过期元素引用会被拒绝，不会重放。

## Checkpoint 行为

Renderer 创建的 Agent 请求带 `responseMessageId`。Gateway 从 conversation/response ID 派生加密 checkpoint thread，并把 AgentBox `BaseCheckpointSaver` 适配器传给图。

直接 graph resume 只用于 provider node 失败：

| 中断                                    | 恢复路径                                                  |
| --------------------------------------- | --------------------------------------------------------- |
| 限流、网络、超时、API 错误              | Descriptor 和上下文 digest 匹配时恢复原 graph thread      |
| Thread 缺失或过期                       | 从已校验 `agentTrace` 重建 provider 历史，并创建新 thread |
| 用户取消                                | `agentTrace` 回退；中断可能发生在副作用内                 |
| 输出或工具轮次上限                      | `agentTrace` 回退并启动新运行                             |
| 未捕获的 tool-node 失败或外部状态不确定 | `agentTrace` 回退；不重新进入外部状态未知的操作           |

未知、无权、格式错误或 Schema 不合法的调用，以及已处理的执行器错误，会变成 error tool result 并通常继续到下一模型轮次。只有逃出 tool node 的异常或外部状态不确定的操作才会进入上表的回退路径。

正常完成会删除 checkpoint thread。中断 thread 保留到恢复、随消息/会话删除，或在 checkpoint 配额下整体回收。

存储、配额与删除详见 [LangGraph 加密 Checkpoint](./langgraph-checkpoints.md)。

## 安全边界

- Provider 凭据和代理配置不进入图状态。
- LangGraph 工具不能绕过 AgentBox 参数校验、已暴露工具别名、审批策略、路径检查、超时和结果限制。
- Runtime 在桌面主进程中强制禁用 LangSmith/LangChain tracing，并运行在无 callback 异步上下文。
- Checkpoint 是加密本机执行状态；`agentTrace` 仍是可移植协议账本和备份形式。
- Renderer 只获取归一化 `StreamEvent`，不直接读取 checkpoint 文件或 provider 协议响应。

## 实现映射

- [`src/electron/api/agent-runtime.ts`](../src/electron/api/agent-runtime.ts)：图状态与转换路由
- [`src/electron/api/gateway.ts`](../src/electron/api/gateway.ts)：请求回调、checkpoint 选择和事件发送
- [`src/electron/browser/browser-tool-executor.ts`](../src/electron/browser/browser-tool-executor.ts)：在 graph tool node 调用的 Gateway 工具回调中完成浏览器审批与分发
- [`src/electron/storage/agentbox-checkpoint-saver.ts`](../src/electron/storage/agentbox-checkpoint-saver.ts)：LangGraph Saver 适配器
- [`src/renderer/src/hooks/useChatStream.ts`](../src/renderer/src/hooks/useChatStream.ts)：事件投影与 `agentTrace` 构造
- [`src/renderer/src/agent-continuation.ts`](../src/renderer/src/agent-continuation.ts)：中断分类与自然恢复指令

## 测试覆盖

- `tests/langgraph-agent-runtime.test.ts`：转换路由、上限、失败、取消和 tracing 隔离
- `tests/gateway-mcp-loop.test.ts`：provider/工具循环、durable provider 恢复、过期 checkpoint 回退、审批、Skills 和内置工具
- `tests/agent-runtime.test.ts`：provider trace 回放与工具安全契约
- `tests/agent-continuation.test.ts`：中断分类和恢复命令规则

## data-plat

受治理数据会话禁用持久图恢复与 provider 原生续传，通过重新读取当前授权执行结果恢复。详见 [data-plat 集成](data-plat-integration.md)。
