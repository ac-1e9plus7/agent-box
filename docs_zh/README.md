# AgentBox 技术文档

> [English documentation](../docs/README.md) · [返回中文项目说明](../README_zh.md)

本文档库按代码模块说明 AgentBox 当前的设计、边界与维护要求。修改行为、接口、Schema、限制或构建流程时，请同步更新对应的中英文文档。

## 文档目录

| # | 文档 | 内容 | 主要源码 |
| --- | --- | --- | --- |
| 1 | [系统架构概览](./architecture.md) | Electron 进程模型、沙箱、preload/IPC 边界、窗口与外链生命周期 | `src/electron/main.ts`, `src/electron/preload.ts`, `src/shared/ipc.ts` |
| 2 | [加密存储与 Vault 安全](./storage-and-vault.md) | safeStorage、AES-256-GCM、Schema、配额、清除数据与 ZIP 备份 | `src/electron/storage/`, `src/electron/backup/` |
| 3 | [API 协议与请求网关](./gateway-and-protocols.md) | OpenAI Chat Completions API、OpenAI Responses API、Anthropic Messages API、SSE、reasoning、web search 与代理 | `src/electron/api/` |
| 4 | [Agent 技能（Skills）系统](./skills-system.md) | 多文件 Skill、内置技能、ZIP 导入导出、检索与动态提示词注入 | `src/electron/storage/default-skills.ts`, `src/shared/skill-zip.ts` |
| 5 | [MCP 外部工具协议与检索](./mcp-integration.md) | stdio / Streamable HTTP / 旧式 HTTP+SSE、连接池、工具检索、审批与多轮 Agent 执行 | `src/electron/mcp/`, `src/electron/api/gateway.ts` |
| 6 | [前端 UI 与交互系统](./ui-and-components.md) | React renderer、消息树、Markdown/KaTeX、附件、用户资料与快捷键 | `src/renderer/src/`, `src/shared/conversation-tree.ts` |
| 7 | [开发、测试与持续集成](./development-and-testing.md) | pnpm 脚本、Vitest、CommonJS 打包约束、冒烟测试与 GitHub Actions | `package.json`, `tests/`, `.github/workflows/` |
| 8 | [会话工作目录与开发运行时](./workspaces-and-runtimes.md) | 工作目录边界、集成终端、JDK/Go/PHP/Python、venv 与 Conda | `src/electron/api/runtime-environments.ts`, `src/renderer/src/workspace-groups.ts` |
| 9 | [国际化与英文术语](./i18n.md) | 首次语言选择、英文为 key 的资源包、生成脚本、check 校验、语义逃生舱与术语 | `src/shared/i18n/`, `scripts/localize-renderer.mjs` |

## 核心维护原则

1. **进程隔离**：renderer 保持 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`；密钥、网络、加密存储与系统进程操作只能位于主进程。
2. **协议与产品实体解耦**：provider、model 与 API format 分别建模；网关把三种上游 API 归一为共享请求和事件类型。
3. **本地数据安全**：Vault 使用 AES-256-GCM，数据密钥由操作系统安全存储封装；安全存储不可用时不得降级为明文。
4. **工作目录边界**：Agent 文件与执行工具只能在会话的绝对工作目录内运行，并拒绝符号链接越界。
5. **双语同步**：根 README、本文档索引和九篇模块文档均保持中英文对应关系；文案和产品术语变更还必须同步资源包与国际化测试。
