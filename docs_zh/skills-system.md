# 4. Agent 技能（Skills）系统

> [English documentation](../docs/skills-system.md)

AgentBox Skill 是一组可复用的本地指令、Markdown 参考资料和参考脚本。激活后，相关内容会加入 Agent 的 System Instructions；脚本文件本身不会因为导入、启用或激活而自动执行。

> **信任边界：** Skill 内容会影响模型的高优先级行为。只导入和启用可信 Skill。即使脚本不会自动运行，Skill 指令仍可要求模型调用代码、终端、文件或 MCP 工具；这些调用继续受工具白名单、参数校验和审批策略约束。

---

## 多文件格式与存储模型

推荐的包结构如下：

```text
skill-package/
├── SKILL.md                 # 入口指令；可带简单 YAML Frontmatter
├── references/              # Markdown 参考资料
│   ├── patterns.md
│   └── standards.md
└── scripts/                 # 仅作为参考源码保存
    ├── runner.py
    └── validator.sh
```

支持的文件分类为 `markdown`、`python`、`shell` 和 `other`：

- 激活 Skill 时，Gateway 会注入入口文档、其他 Markdown、Python 和 Shell 文件，并明确把脚本标记为“未自动执行”的参考代码。
- `other` 文件可以存储和随 ZIP 导入/导出，但当前不会加入 Agent System Instructions。
- Skill 最多包含 50 个文件，每个文件最多 500,000 字符；路径最长 255 字符，必须是包内相对路径，禁止绝对路径和 `..` 穿越。Vault 内最多保存 500 个 Skill（包含内置 Skill）。
- 内置 Skill 不可删除，但可停用；“重置默认技能”会恢复内置内容并保留自定义 Skill。

存储校验与迁移见 [`src/electron/storage/app-repository.ts`](../src/electron/storage/app-repository.ts)。

---

## ZIP 与文本导入/导出

[`src/shared/skill-zip.ts`](../src/shared/skill-zip.ts) 使用 `fflate` 在 Renderer 中读写普通 ZIP：

- **导出**：保留 Skill 的全部文件；如果入口文档没有 Frontmatter，会补写 `name`、`description`、`version`、`author` 和 `icon`。
- **ZIP 导入**：忽略 `__MACOSX` 与 `.DS_Store`；如果所有文件共用一个顶层目录，会移除该目录。入口优先级为 manifest 指定路径、`SKILL.md`、`README.md`、第一个 Markdown、首个文件。
- 元数据优先读取根目录的 `skill.json` / `manifest.json`；没有 manifest 时读取入口文档的简单 Frontmatter。仍缺少名称或描述时，再回退到 H1、首段或默认值。
- **JSON 文本导入**：设置页也接受单个对象或数组；每项至少需要非空 `name` 与 `systemPrompt`，可附带 `files`、`entryFile`、作者和版本。
- 新导入的 Skill 默认启用，最终仍经过主进程的文件数量、路径和内容大小校验。

Skill ZIP 归档与会话备份是不同格式。会话备份由 [`src/electron/backup/backup-export.ts`](../src/electron/backup/backup-export.ts) 流式生成，并可使用 WinZip AES-256；Skill ZIP 归档不包含 Vault 密钥、密码或外部工作目录，也不提供密码保护。

---

## 五个内置 Skill

[`src/electron/storage/default-skills.ts`](../src/electron/storage/default-skills.ts) 当前提供：

1. **代码执行与算法助手**（`code-interpreter`）：代码、调试、算法、复杂度、测试和性能优化。
2. **数据分析与表格可视化**（`data-analyst`）：CSV/Excel、统计、趋势分析和图表规范。
3. **研报萃取与长文精读**（`web-extractor`）：PDF、网页、论文、研报和长文信息提取。
4. **专业多语言精翻与本地化**（`translator-polyglot`）：翻译、本地化和术语一致性。
5. **提示词工程专家**（`prompt-optimizer`）：系统提示词、任务指令、角色与结构化模板。

内置名称、描述和文档会随应用语言本地化；用户对启用状态和自定义内容的修改会保留。

---

## Gateway 路由与渐进加载

Skill 只在 **Agent 模式**下参与路由。流程如下：

1. Gateway 读取全部 `enabled: true` 的 Skill，并把名称、ID 和描述组成轻量目录。
2. 会话固定的 `skillIds` 优先；否则先识别 `$id`、`@id`、独立出现的完整 ID 或完整 Skill 名称。
3. 没有显式命中时，检索最近 3 条用户消息。文本附件最多贡献前 2,000 字符，二进制附件只贡献文件名和 MIME type；最多自动激活 2 个达到阈值的 Skill。
4. 只有激活 Skill 的入口文档、Markdown 参考资料及 Python/Shell 参考源码会加入 System Instructions，避免一次加载全部 Skill。
5. 如果初始路由不足，模型可调用只读的 `agentbox_load_skill`，按目录中的 `skill_id` 加载另一个已启用 Skill。该工具不会执行脚本，也不要求工具审批。
6. 自动、显式和模型按需激活都会发送 `skill-activated` 事件，Renderer 会记录激活来源。

检索实现见 [`src/electron/api/skill-retriever.ts`](../src/electron/api/skill-retriever.ts)，提示词装配和按需加载见 [`src/electron/api/gateway.ts`](../src/electron/api/gateway.ts)。

---

## 脚本与工具的执行边界

### 参考脚本不等于已执行代码

`scripts/*.py`、Shell 文件或代码块只是模型可阅读的参考实现。AgentBox 不会把它们写入工作目录，也不会直接启动这些文件。模型只有显式调用某个执行工具并收到成功结果后，才能声称完成了实际运行。

### `agentbox_run_code`

只要至少一个已启用 Skill 含 Python 文件，Gateway 就会提供内置代码运行器。它接收模型在调用参数中提交的短代码，而不是自动运行 Skill 包内的脚本：

- JavaScript 在独立 Worker 的 `vm` context 中运行，只暴露受限 `console` 和 `input`；禁用字符串代码生成和 WebAssembly，并设置 Worker 内存上限。
- Python 使用“设置 → 开发运行时”解析出的解释器，或回退到可用的本机 Python 3。包装器使用 `-I`、精简环境变量、受限 builtins 和标准库白名单，并拒绝文件打开、动态执行和双下划线属性等操作。
- 代码最多 100,000 字符，输出最多 200,000 字符；默认超时 8 秒，可请求 0.5–20 秒。
- 代码运行器是降低风险的受限执行环境，不应视为完整的操作系统级沙箱。除 Full Access 外，每次运行都需要用户审批。

### 工作区文件与集成终端

- `agentbox_read_file` / `agentbox_write_file` 用本机文件 API 读取或写入会话工作目录内的 UTF-8 文件，不经过 Shell 转义；写入工具在默认策略下需要审批。
- `agentbox_run_terminal` 用用户配置的跨平台 Shell 执行编译器、包管理器或系统命令。它可以产生任意系统副作用，除 Full Access 外每条命令都需要审批。
- 终端以会话目录作为初始 `cwd`，但不是目录沙箱。需要创建源码或多行文本时应优先使用受边界约束的工作区文件工具。

详细运行时和路径规则见[会话工作目录与开发运行时](workspaces-and-runtimes.md)，统一审批规则见 [MCP 外部工具协议与智能检索](mcp-integration.md)。
