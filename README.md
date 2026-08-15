# ChatBoxLite

ChatBoxLite 是一个使用 React、TypeScript 与 Electron 构建的本地 AI 聊天客户端。交互参考 Chatbox：会话与模型选择集中在主界面，回复使用流式展示；请求由 Electron 主进程发出，渲染进程不会直接接触 API Key。

项目默认面向 [OpenRouter](https://openrouter.ai/)，也提供 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 本地连接预设；同时把“模型”“上游供应商”和“API 格式”拆分配置，便于同一个模型按不同路由或协议调用。

## 主要功能

- 多会话聊天、流式回复、停止生成与错误提示。
- 模型列表、当前模型选择，以及自定义模型 ID。
- 为每个模型配置上下文窗口和最大输出长度。
- 上下文管理可选手动或自动，默认手动；超限时可仅为当前请求按完整轮次裁剪，不会删除本地历史。
- 配置 OpenRouter、OpenAI、Anthropic 或自定义兼容服务，并为模型绑定对应连接。
- 使用 CLIProxyAPI 本地预设快速连接 `http://127.0.0.1:8317/v1`，支持其 Chat Completions、Responses 与 Anthropic Messages 兼容端点。
- 为 OpenRouter 模型限定上游供应商，并配置回退、排序、数据收集与 ZDR 等路由偏好。
- 支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 三种 API 格式。
- 可按会话启用或关闭思考模式，并展示可见思考内容、推理 token 用量与当前 effort。
- 支持 OpenRouter 联网搜索 server tool，可选自动搜索或原生优先，并展示结构化来源与实际搜索次数。
- 会话、消息、模型设置、供应商设置和 API Key 均在本机加密保存。

> “上下文窗口”是客户端用于估算、校验和裁剪消息的预算，不会改变模型在 OpenRouter 或上游供应商处的真实限制。配置值高于真实上限时，请求仍可能被拒绝或被上游截断。

新建本地数据时，内置 `OpenRouter Auto` 模型默认使用 1,000,000 token 上下文窗口和 128,000 token 最大输出。该默认值只应用于新建 vault；已有 vault 中的模型数值会原样保留，避免覆盖用户自定义配置。

模型设置中的 `− / +` 按钮以 64,000 token 为基础步长，并在 `64K × 2ⁿ`、1,000,000 和 2,000,000 等常用节点优先停靠；直接输入仍可配置小于 64K 的真实模型上限。

### 上下文管理

- **手动（默认）**：完整保留会话历史。估算超限时阻止普通发送，由用户调整内容、模型预算或选择“本次裁剪并发送”。单次裁剪只改变该次请求携带的历史，不修改设置，也不删除本地消息。
- **自动**：估算超限时从最早历史开始按完整的用户＋助手轮次裁剪；系统提示词和最新问题始终保留。若这两部分本身已超限，请求仍会被阻止。

旧版本地数据没有该设置时会迁移为手动模式，避免升级后静默丢弃请求上下文。

## 模型、供应商与 API 格式

三者是相互独立的概念。这里的“供应商”还分为 API 连接与 OpenRouter 上游路由两层：

- **模型**：OpenRouter 模型标识，例如 `anthropic/claude-sonnet-4`。
- **API 连接供应商**：客户端直接访问的服务，包含类型、Base URL、API Key、默认请求头和默认 API 格式；可以是 OpenRouter、CLIProxyAPI、OpenAI、Anthropic 或自定义兼容服务。
- **OpenRouter 上游供应商**：实际执行推理的 endpoint/provider。界面可配置 `only`、`allow_fallbacks`、排序、数据收集与 ZDR 等偏好，用于控制延迟、价格、数据策略或功能兼容性；是否真正可用仍取决于该模型当前的 OpenRouter 路由。
- **API 格式**：客户端发送请求、解析普通响应和解析 SSE 流事件时使用的协议形状。它不等同于模型厂商。

### 三种 API 格式

| API 格式 | OpenRouter 端点 | 请求与返回形状 | 适用场景 | 主要限制 |
| --- | --- | --- | --- | --- |
| OpenAI Chat Completions | `POST /api/v1/chat/completions` | `messages`、`max_tokens`；返回 `choices[].message`，流式为增量 `delta` | 默认选择；兼容模型最广，适合普通多轮聊天 | 高级能力需要 OpenRouter 转换成上游格式；不同模型可能忽略或拒绝部分采样、工具、思考参数 |
| OpenAI Responses | `POST /api/v1/responses` | `input`/`instructions`、`max_output_tokens`；返回带类型的 `output` 项，流式为具名事件 | 需要结构化 reasoning、工具调用或 Responses 生态时 | OpenRouter 的实现是**无状态**的：必须随请求发送完整历史；`store: true` 与非空 `previous_response_id` 会返回 400；事件和错误结构不能按 Chat Completions 解析 |
| Anthropic Messages | `POST /api/v1/messages` | 顶层 `system`、`messages` 内容块、`max_tokens`；返回 `content` 块，流式为 Anthropic 事件 | Claude 原生语义、扩展思考和内容块处理 | 角色、工具 schema、停止原因和 token 字段与 OpenAI 格式不同；并非所有模型或上游都完整支持 Anthropic 专有能力，跨供应商转换可能丢失语义 |

对应的官方资料：

- [Chat Completions API](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion)
- [Responses API](https://openrouter.ai/docs/api_reference/responses/overview)
- [Anthropic Messages API](https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-messages)
- [OpenRouter 供应商路由](https://openrouter.ai/docs/guides/routing/provider-selection)

### CLIProxyAPI 本地连接

在“设置 → 服务商”选择“CLIProxyAPI 本地预设”，即可创建默认连接 `http://127.0.0.1:8317/v1`。客户端通过统一的 `GET /v1/models` 发现模型，并可按模型选择 Chat Completions、Responses 或 Anthropic Messages 格式。

- CLIProxyAPI 配置了 `api-keys` 时，请在连接中填写其中一个密钥；本机回环地址允许留空，客户端不会发送空的鉴权头。
- **密钥留空时，务必在 CLIProxyAPI 配置中设置 `host: "127.0.0.1"`。** 仅让客户端访问 `127.0.0.1` 并不能限制代理的监听范围；CLIProxyAPI 的空 `host` 配置可能同时暴露到局域网，而默认又未启用 TLS。
- 远程 CLIProxyAPI 地址仍强制要求 API Key，并要求 HTTPS；无密钥例外只适用于 `localhost`、IPv4 `127.0.0.0/8` 和 IPv6 `::1`。
- CLIProxyAPI 的通用 `/v1/models` 结果通常不包含可靠的上下文窗口、最大输出长度或思考能力元数据。导入模型后请按实际账号和模型手动校准这些配置。

参见 [CLIProxyAPI 快速开始](https://help.router-for.me/introduction/quick-start) 与 [基础配置](https://help.router-for.me/configuration/basic)。

### 思考模式的边界

思考开关表达的是客户端请求偏好，协议适配层会把它转换为所选 API 格式支持的字段。需要注意：

- 思考开关是会话级状态。模型设置中的“默认开启”只影响之后新建的会话，不会静默修改已有会话；输入框旁会明确显示“思考关闭”或当前 effort。
- 只有模型、供应商和 API 格式都支持时，思考参数才会生效；否则上游可能忽略参数或返回参数错误。
- 上游可能返回完整思考块、思考摘要、加密 reasoning item，或完全不返回可展示的思考文本。
- 模型没有返回可见思考文本、但用量包含 reasoning token 时，界面会显示“模型未返回可见思考”，以免把隐藏思维链误判为未启用。
- 关闭思考模式不代表模型在内部不进行推理，也不保证一定减少输出 token 或费用。
- 切换格式后，历史中的工具调用、思考块等专有内容不一定能无损转换；重要会话建议保持同一种格式。

### OpenRouter 联网搜索

联网搜索通过 OpenRouter 当前推荐的 `openrouter:web_search` server tool 实现，适用于本应用支持的三种 OpenRouter API 格式。每个会话可选择：

- **关闭（默认）**：不向请求添加搜索工具。
- **自动搜索**：由 OpenRouter 自动选择搜索引擎，模型按问题决定是否使用。
- **原生优先**：优先使用模型供应商的原生搜索；当前路由不支持时由 OpenRouter 回退到其他搜索引擎。

客户端将每次请求限制为最多 2 次搜索、每次最多 5 个结果、合计最多 8 个结果。回复会展示安全校验后的结构化来源和实际搜索次数；上游只返回搜索次数而没有 citation 时也会明确提示。

这里的“原生优先”描述的是 OpenRouter 的搜索路由能力，不等于所选模型厂商公开 API 本身提供搜索。例如 DeepSeek 的网页/App 产品具有联网功能，但其公开模型 API 当前没有通用的原生网页搜索工具；DeepSeek 模型经 OpenRouter 联网时可能回退到 Exa 等 OpenRouter 搜索服务。旧的 `:online` 模型后缀和 `plugins: [{ id: 'web' }]` 方式已弃用，本项目不会使用它们。

启用联网会把查询和必要上下文发送给 OpenRouter、模型上游及实际搜索服务，并可能同时产生搜索费用与额外模型 token 费用。处理敏感内容前请确认各方的数据政策；界面会在联网开启期间持续显示这一提示。

## 安全模型

### 本地静态数据

ChatBoxLite 使用两层密钥模型：

1. 主进程首次运行时生成随机 256-bit vault 主密钥。
2. 主密钥通过 Electron [`safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage) 交由操作系统凭据设施封装。
3. 会话、消息、模型/供应商设置和 API Key 组成的整份 vault 使用 AES-256-GCM 加密；每次写入使用随机 IV 和认证标签，并通过临时文件替换进行原子落盘。
4. 封装后的主密钥与 vault 的 ciphertext、IV、认证标签分开保存在 `app.getPath('userData')/vault` 下，不写入项目目录。

应用不会在 `safeStorage` 不可用时降级为明文存储；Linux 检测到 `basic_text` 后端时同样拒绝保存敏感数据。用户需要先为系统配置可用的 Secret Service/密钥环。

### 进程隔离

- API 请求、解密和文件读写只发生在 Electron 主进程。
- renderer 启用上下文隔离，只能通过 preload 的 `window.chatbox` 白名单调用 IPC。
- API Key 对 renderer 是“可写不可读”的：界面只能获知是否已配置，不能读取密钥明文。
- 流式请求在主进程中归一化为统一事件，renderer 不接触鉴权请求头。

### 威胁边界

本地加密主要防止应用数据文件被离线复制后直接读取，并提供 GCM 完整性校验。它不防护以下情况：

- 攻击者已控制当前操作系统账户、正在运行的应用进程，或能读取进程内存。
- 恶意软件能够以用户身份调用操作系统凭据服务。
- 消息发送到配置的 API 后，OpenRouter 与实际上游供应商会处理其明文；本地加密不是与模型服务之间的端到端加密。
- 调试日志、崩溃转储或用户主动导出的内容。开发和排障时不要记录请求头、API Key、主密钥或解密后的完整 vault。

丢失操作系统凭据、用户配置目录中的封装密钥或 vault 文件，可能导致历史数据无法恢复。当前设计不提供云同步或密钥找回。

## 开发

### 环境要求

- Node.js 22 或更高版本
- pnpm 10 或更高版本
- 可用的系统凭据后端：Windows Credential Protection、macOS Keychain，或 Linux Secret Service

本仓库应提交 `pnpm-lock.yaml`；不要使用 npm、Yarn 重写锁文件。

```powershell
pnpm install
pnpm dev
```

开发模式会启动 Vite renderer 和 Electron 主进程。首次使用时，在设置中填写 OpenRouter API Key、添加或选择模型，然后新建会话。

### 检查与测试

```powershell
pnpm typecheck
pnpm test
pnpm build
```

- `typecheck`：检查 main、preload、shared 与 renderer 的 TypeScript 类型。
- `test`：运行协议事件、请求体适配和上下文裁剪单元测试。
- `build`：生成生产环境的 Electron/Vite 产物，是提交前最低限度的集成验证。

### 打包

```powershell
pnpm package
pnpm dist
```

- `package` 使用 `electron-builder --dir` 生成当前平台的未封装应用目录，适合本机冒烟测试。
- `dist` 生成当前平台的可分发产物，例如 Windows NSIS/portable、macOS DMG 或 Linux AppImage。

发布前应在目标系统分别验证 `safeStorage`、应用数据目录权限、首次创建 vault、升级读取旧 vault 和流式中止行为。Electron 应用通常需要在目标平台完成代码签名；未签名开发包可能触发系统安全警告。

## 项目结构

```text
src/
  electron/       Electron main、preload、协议适配、网络与加密存储
  renderer/       React 用户界面
  shared/         main/preload/renderer 共用的类型与 IPC 契约
```

安全相关改动应保持两个不变量：renderer 永远拿不到 API Key 明文；任何敏感数据都不得在无安全凭据后端时以明文落盘。

## 隐私与费用提示

OpenRouter API Key、模型可用性、价格、速率限制、上下文上限和供应商路由均由对应服务控制并可能变化。发送前请确认所选模型及供应商的数据处理政策；模型回复和思考 token 都可能计费，最终以 OpenRouter 的用量记录为准。
