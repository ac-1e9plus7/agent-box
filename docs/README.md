# AgentBox 技术文档中心

欢迎查阅 AgentBox 的架构与技术开发文档。本文档库按模块组织，旨在为开发者、维护者和编码智能体提供清晰、详尽的系统设计原理、核心接口规范与最佳实践。

---

## 📚 文档目录

| 文档模块 | 主要内容 | 关键源码文件 |
| --- | --- | --- |
| [1. 系统架构概览](./architecture.md) | 进程模型、沙箱隔离、IPC 契约、安全性不变量与生命周期 | `src/electron/main.ts`, `src/electron/preload.ts`, `src/shared/ipc.ts` |
| [2. 加密存储与 Vault 安全](./storage-and-vault.md) | 双层密钥模型、AES-256-GCM、浅/深 ZIP 备份、原子落盘、资源配额限制 | `src/electron/storage/`, `src/electron/backup/` |
| [3. API 协议与请求网关](./gateway-and-protocols.md) | 3 种 API 格式适配、流式解析、思考模式、联网搜索、代理转发 | `src/electron/api/` |
| [4. Agent 技能（Skills）系统](./skills-system.md) | 多文件技能规范、Python 3 优先、Zip 导入导出生态、动态提示词注入 | `src/electron/storage/default-skills.ts`, `src/shared/skill-zip.ts` |
| [5. MCP 外部工具协议与检索](./mcp-integration.md) | Stdio/SSE 传输、连接池管理器、BM25 智能工具检索、Agent 多轮循环调用 | `src/electron/mcp/`, `src/electron/api/gateway.ts` |
| [6. 会话工作目录与开发运行时](./workspaces-and-runtimes.md) | 目录分组、终端 cwd、JDK/Go/PHP/Python、venv 与 Conda | `src/electron/api/runtime-environments.ts`, `src/renderer/src/workspace-groups.ts` |
| [7. 前端 UI 与交互系统](./ui-and-components.md) | 树状会话与分支版本、Markdown & LaTeX 公式渲染、多模态附件、快捷键 | `src/renderer/src/` |
| [8. 开发、测试与持续集成](./development-and-testing.md) | 构建命令、TypeScript 类型配置、Vitest 测试规范、跨平台 CI/CD 打包 | `tests/`, `package.json`, `.github/workflows/` |

---

## 🧭 快速导览与核心设计原则

1. **强进程隔离（Process Sandboxing）**：
   渲染进程（Renderer）运行在沙箱中（`sandbox: true, contextIsolation: true, nodeIntegration: false`），**绝对禁止接触 API Key 明文**，所有外部网络请求、加密存储与系统进程操作均必须且仅能在 Electron 主进程执行。
2. **多协议原生适配（Multi-protocol Native Support）**：
   解耦“模型”、“供应商连接”与“API 格式”。统一支持 OpenAI Chat Completions、OpenAI Responses 与 Anthropic Messages 三大协议格式，并在网关层完成双向归一化转换。
3. **专家级 Agent 与工具生态（Dual-Track Agent Ecosystem）**：
   - **Skills 技能体系**：以多文档 Markdown + Python 3 / Shell 规范，通过 Prompt Augmentation 注入高阶思维模式与沙箱脚本。
   - **MCP 外部工具体系**：以 Model Context Protocol 为标准，支持 Stdio/SSE 接入本地与网络服务，通过 BM25 智能检索选出 Top-K 工具并驱动多轮自主执行循环。
4. **安全与隐私优先（Privacy & Security by Default）**：
   本地数据全程 AES-256-GCM 加密，主密钥受操作系统凭据设施（Windows Credential Protection / macOS Keychain / Linux Secret Service）保护；默认选用 OpenRouter Zero Data Retention（ZDR）与拒绝数据留存路由。
