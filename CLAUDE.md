# CLAUDE.md

本文件为在本仓库中工作的 Claude Code 提供项目级约束。开始修改前先阅读本文件与 `README.md`；用户的当前要求始终优先。

## 项目概览

ChatBoxLite 是一个 React 19 + TypeScript + Electron 35 + electron-vite 桌面聊天客户端，主要面向 OpenRouter，同时支持 CLIProxyAPI、OpenAI、Anthropic 和自定义兼容服务。

核心目标：

- renderer 不接触 API Key 明文，不直接访问模型 API。
- 主进程统一处理网络请求、协议适配、加密存储和资源限制。
- 同时支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages。
- 会话、模型、供应商和密钥只在本机加密保存。
- 旧 vault 必须保持可读，不能因新增限制或默认值被静默覆盖。

## 常用命令

只使用 pnpm；不要用 npm、npx 或 Yarn 改写锁文件。

```powershell
pnpm install
pnpm dev
pnpm typecheck
pnpm test
pnpm build
pnpm package
pnpm dist
```

- `pnpm dev`：启动 Vite renderer 和 Electron。
- `pnpm typecheck`：检查 main、preload、shared 和 renderer。
- `pnpm test`：运行 Vitest Node 测试。
- `pnpm build`：先执行类型检查，再生成生产构建。
- `pnpm package`：生成未封装应用目录。
- `pnpm dist`：生成平台安装包。

提交改动前至少运行 `pnpm test` 和 `pnpm build`。协议、安全、存储相关改动必须补测试。

## 目录与职责

```text
src/shared/                         跨进程类型与 IPC channel
src/electron/main.ts                Electron 生命周期、窗口与外链策略
src/electron/preload.ts             最小化、冻结的 window.chatbox API
src/electron/ipc/register-ipc.ts    IPC 注册与 sender 校验
src/electron/api/gateway.ts         网络、超时、流式请求、取消
src/electron/api/request-adapters.ts 三种请求格式的请求体构造
src/electron/api/protocol-adapters.ts 三种 SSE/响应格式的统一解析
src/electron/api/provider-policy.ts URL、鉴权和 provider 安全策略
src/electron/api/context-window.ts  token 估算与完整轮次裁剪
src/electron/storage/               加密 vault、schema、配额和仓库操作
src/renderer/src/App.tsx            renderer 状态与业务编排
src/renderer/src/components/        React UI
tests/                              协议、schema、配额和纯函数测试
```

保持职责边界：renderer 只处理展示和用户交互；所有密钥、网络和持久化操作必须留在主进程。

## 不可破坏的安全约束

### 密钥与本地存储

- API Key 对 renderer 必须保持“可写不可读”。`ProviderView` 只能暴露 `hasApiKey`，不能加入读取密钥的 IPC。
- 不得把 API Key、vault 主密钥、鉴权头、解密后的 vault 或完整敏感请求写入日志、错误消息、测试快照或 renderer state。
- vault 使用随机 256-bit 主密钥；主密钥由 Electron `safeStorage` 封装，数据使用 AES-256-GCM。
- 不得在 `safeStorage` 不可用或 Linux `basic_text` 后端时降级到明文。
- 保持随机 IV、认证标签、原子文件替换和单实例锁；不要以关闭这些机制解决开发问题。
- 修改存储字段时，同时更新 shared 类型、读取校验、写入校验、资源计数和兼容测试。

### Electron 与 IPC

- 保持 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false` 和 `webSecurity: true`。
- sandboxed preload 必须输出 CommonJS `out/preload/index.cjs`；不要改回含顶层 import 的 ESM preload，也不要通过关闭 sandbox 规避加载问题。
- preload 只暴露 `window.chatbox` 白名单，并保持 deep freeze。
- IPC 必须同时校验目标 `WebContents`、`senderFrame === mainFrame` 和精确页面 URL。
- 生产 renderer 使用 `file://`，CSP 必须保留在 `src/renderer/index.html` 的 meta 中；HTTP response header 不能为 `file://` 提供 CSP。
- 新窗口始终由 Electron 拒绝。只有经过主进程二次校验的 `http:`/`https:` URL 可交给 `shell.openExternal`。

### 网络

- 远程 Base URL 必须使用 HTTPS；HTTP 只允许 loopback。
- CLIProxyAPI 只有 loopback 地址可以不填 API Key；远程 CLIProxyAPI 必须 HTTPS + Key。
- 缺少 Key 时不得发送空 `Authorization` 或 `x-api-key` 头。
- 保持 `redirect: 'error'`、请求超时、响应体/SSE 大小限制和取消能力。
- 错误回显必须脱敏；不要把上游任意大响应完整读入内存。

## 数据兼容规则

- 当前 vault 为 schema v1，旧数据中的新增字段通常是 optional，并在读取时应用安全默认值。
- 默认值调整只影响新建 vault，除非存在明确、可证明安全的迁移标记。不要根据模型 ID 或旧数值猜测并覆盖用户配置。
- 不要在 vault 加载路径新增会拒绝历史合法数据的全局硬限制。
- aggregate 会话配额只在保存 mutation 时检查：旧数据若已超限，允许持平、缩小或删除，但不得继续增长。
- 删除操作必须保持可用，以便用户从超限或异常状态恢复。
- 对话保存失败时不得继续发起付费模型请求；应恢复输入和 UI 状态并提示用户。

## API 与协议约束

### 三种格式

- Chat Completions：`/chat/completions`，正文来自 `choices[].delta.content`。
- Responses：`/responses`，OpenRouter 端点是无状态的，必须携带完整历史；assistant 历史使用 Responses message/output_text 形状。
- Anthropic Messages：`/messages`，系统提示位于顶层 `system`，消息为 Anthropic 角色与内容块语义。
- 所有上游事件统一转换为 `StreamEvent`；renderer 不应解析供应商原始 SSE。
- 解析不可信响应时使用字段白名单。不要递归显示未知对象，也不要把 `web_search_result`、tool result 或网页片段误当模型最终回答。

### 思考模式

- 思考开关是会话级状态；模型默认仅影响新会话，不得覆盖已有会话的显式 `false`。
- OpenRouter Chat/Responses 开启时使用统一 `reasoning` 配置，关闭时使用 `effort: 'none'`。
- CLIProxyAPI 需要兼容其 Chat/Responses 推理字段转换。
- Anthropic Messages 必须按模型配置使用 adaptive/manual thinking；关闭发送协议合法的 disabled 形状。
- 同时解析 `reasoning`、`reasoning_content`、reasoning details、Responses reasoning 事件和 Anthropic thinking delta。
- 没有可见思考文本不代表没有推理；保留并展示 `reasoningTokens`。不得伪造或推断隐藏思维链。

### OpenRouter 联网搜索

- 只对 `provider.kind === 'openrouter'` 启用 `openrouter:web_search` server tool。
- 支持 `off`、`auto`、`native`；`native` 不可用时 OpenRouter 会回退，不得把它描述为模型厂商保证的原生能力。
- 请求必须同时保留 `max_uses: 2` 和顶层 `max_tool_calls: 2`，以限制费用和工具循环。
- 当前每次搜索最多 5 个结果、整次请求最多 8 个结果。调整这些值时同步更新 UI、README 和测试。
- 解析 Chat annotations、Responses annotations 和 Anthropic citation delta；URL 只接受无凭据的 HTTP/HTTPS。
- 完全重复的 citation 应抑制，同 URL 后续补充 title/content/range 时应允许富化。
- DeepSeek 的公开模型 API 不提供通用原生网页搜索工具。DeepSeek 经 OpenRouter 搜索可能使用 Exa 等回退服务，不得标为“DeepSeek 原生搜索”。
- 搜索执行但模型未返回正文时，保留来源并显示明确提示，不要编造答案。

## 上下文管理

- `contextManagementMode` 默认 `manual`。
- 手动模式超限时阻止普通发送；`allowContextTrimming` 只允许该次请求裁剪，不修改全局设置，也不删除本地历史。
- 自动模式只按完整 user + assistant 轮次裁剪，保持角色序列合法。
- 系统提示和最新用户问题不可裁剪；两者本身超限时必须阻止请求。
- 上下文窗口是客户端预算，不代表能改变供应商的真实模型上限。
- token 数字按钮以 64,000 为基础步长，并在 `64K × 2^n`、1M、2M 等锚点停靠；直接输入的 schema 下限与按钮步长不是同一概念。

## React 与状态处理

- 共享持久化类型来自 `src/shared/types.ts`；renderer 扩展类型放在 `src/renderer/src/types.ts`。
- 旧会话缺少可选字段时使用兼容默认值，不要在 bootstrap 时无条件写回整个 vault。
- 开始流式请求前必须先成功保存用户消息；失败时停止请求并恢复草稿。
- 流式 usage 事件可能分多次到达，按字段合并而不是整体覆盖。
- citations 按规范化 URL 合并；完成消息必须保存 reasoning、usage 和 citations。
- 外部 Markdown 链接使用 `target="_blank"` 和 `rel="noopener noreferrer"`，实际打开由主进程安全策略处理。
- 对空白正文使用 `trim()` 判断；有来源但没有正文时显示上游未生成正文的状态，不显示无意义的复制按钮。

## 代码风格

- TypeScript strict、`noUncheckedIndexedAccess` 已开启；不要用 `any` 绕过边界校验。
- 优先使用小型纯函数和显式类型守卫处理外部数据。
- 对用户/网络/vault 输入先校验、规范化，再存储或转发。
- 避免在 renderer 与 main 重复实现协议规则；协议逻辑集中在 Electron API adapter。
- 保持现有无分号风格和尾随逗号风格，不进行与任务无关的大规模格式化。
- 修改用户可见行为或限制时同步更新 `README.md`。

## 测试要求

按改动范围补测试：

- 请求参数或 reasoning/web search：`tests/protocol-adapters.test.ts`
- SSE、citations、usage：`tests/protocol-adapters.test.ts` 与 `tests/web-metadata-schema.test.ts`
- URL、鉴权、CLIProxy：`tests/provider-policy.test.ts`
- 模型发现：`tests/model-catalog.test.ts`
- 上下文裁剪：`tests/context-window.test.ts`
- vault 配额和旧数据兼容：`tests/vault-resource-limits.test.ts`
- 默认模型：`tests/default-models.test.ts`
- token 步进：`tests/token-step.test.ts`

测试至少覆盖：正常路径、关闭状态、旧字段缺失、非法/超大外部输入、取消或失败路径，以及三种 API 格式中受影响的每一种。

## 开发排障提示

- `pnpm dev` 编译成功但新窗口立即退出时，先检查是否已有 ChatBox Lite/Electron 实例持有 single-instance lock。
- 窗口空白且 `window.chatbox` 不存在时，检查 preload 是否仍输出并加载 `index.cjs`，不要关闭 sandbox。
- 首次启动失败时检查 `safeStorage`/系统凭据后端，不要创建明文 fallback。
- 使用真实 API 调试时，通过现有 IPC/主进程链路发请求；不要读取、打印或复制用户 Key。诊断会话应使用临时 ID、避免保存，并限制输出、工具调用和费用。

## 完成检查清单

1. 安全边界、旧 vault 和三协议是否仍兼容。
2. 类型、schema、IPC、renderer 状态是否同步更新。
3. 是否补充了相应 Vitest 用例。
4. 是否更新了用户可见文档。
5. `pnpm test` 通过。
6. `pnpm build` 通过。
7. 没有日志、fixture、截图或错误信息包含密钥或敏感 vault 内容。
