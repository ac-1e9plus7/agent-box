# AgentBox

[English](./README.md) | **简体中文**

> **私密、强大的多模型 AI 智能体桌面客户端**
>
> 基于 React 19、TypeScript 5.7 与 Electron 35 构建，原生适配 OpenAI Chat Completions API、OpenAI Responses API 与 Anthropic Messages API，并集成 Agent Skills 和 Model Context Protocol (MCP) 服务器。

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61dafb.svg)](https://react.dev/)
[![Electron](https://img.shields.io/badge/Electron-35-47848F.svg)](https://www.electronjs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

## 核心特性

- **本地优先的加密存储：** Renderer 完全沙箱化，已存储的 API 密钥绝不会以明文返回。随机数据密钥由操作系统安全存储保护，Vault 使用 AES-256-GCM 加密落盘。
- **可携带会话备份：** 导出无损 JSON 和可读 Markdown。浅备份包含会话，深备份还会收集去重后的会话工作目录。可选密码使用 WinZip AES-256 (AE-2) 保护文件内容。
- **供应商、模型与 API 格式解耦：** 分别配置供应商、模型和线上协议。支持 OpenAI Chat Completions API、OpenAI Responses API 与 Anthropic Messages API，预置 [OpenRouter](https://openrouter.ai/) 和本地 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 连接。
- **MCP 服务器集成：** 支持本地 `stdio`、远程 Streamable HTTP，并兼容旧式 HTTP+SSE。BM25 工具检索、会话级服务器选择、审批策略和 Tool Explorer 便于管理大型工具目录。
- **可恢复的 Agent 执行：** Agent 模式默认最多运行 30 轮工具调用，可配置为 1–100。安全 provider 失败使用加密 LangGraph checkpoint sidecar；输出上限、取消和副作用不确定状态仍使用可移植 `agentTrace` 回退。
- **集成终端和工作区文件工具：** 自动探测跨平台 Shell，也可自定义可执行文件和参数。原生文件工具可分段读取 UTF-8 文本，并在不经过 Shell 转义的情况下创建、覆盖或追加文件。
- **会话级开发环境：** 每个会话都绑定工作目录。可配置 JDK、Go、PHP 和 Python；Python 支持项目 `.venv`/`venv`、系统解释器、普通虚拟环境、Conda 环境和自定义解释器。
- **多文件 Agent Skills：** Skill 可包含 Markdown 指令、参考文档以及不会自动执行的 Python / Shell 参考脚本。支持会话固定、`$skill-id` 显式调用、自动检索和模型按需加载，并可导入导出 ZIP Skill 归档。
- **富聊天界面：** 支持 Markdown、GFM、代码高亮、KaTeX 数学公式、多模态附件、图片优化与预览、可编辑会话树、重新生成分支和版本切换。
- **推理与联网搜索：** 归一化支持供应商的推理内容与用量。OpenRouter 联网搜索使用 `openrouter:web_search` 服务器工具，支持自动或供应商原生搜索和结构化引用。
- **英文与简体中文 UI：** Renderer 和 Electron 主进程共用语言资源。首次启动时，中文系统 locale 默认使用简体中文，其他 locale 默认使用英文；用户选择会保存在加密设置中。

## 技术文档

中文文档位于 [`docs_zh/`](./docs_zh/README.md)，对应的英文文档位于 [`docs/`](./docs/README.md)。

- [系统架构与进程隔离](./docs_zh/architecture.md)
- [加密存储与 Vault 安全](./docs_zh/storage-and-vault.md)
- [API 协议与请求网关](./docs_zh/gateway-and-protocols.md)
- [Agent Skills 系统](./docs_zh/skills-system.md)
- [MCP 服务器与工具检索](./docs_zh/mcp-integration.md)
- [UI 与交互模型](./docs_zh/ui-and-components.md)
- [开发、测试与发布](./docs_zh/development-and-testing.md)
- [工作目录与开发运行时](./docs_zh/workspaces-and-runtimes.md)
- [国际化设计](./docs_zh/i18n.md)
- [LangGraph Agent Runtime](./docs_zh/langgraph-agent-runtime.md)
- [LangGraph 加密 Checkpoint](./docs_zh/langgraph-checkpoints.md)

## 快速开始

### 环境要求

- Node.js 24 或更高版本
- pnpm 11.24.0（通过 `packageManager` 固定）
- 操作系统凭据后端：Windows 凭据保护、macOS Keychain 或 Linux Secret Service

### 安装与运行

```powershell
git clone https://github.com/ac-1e9plus7/agent-box.git
cd agent-box
corepack enable
pnpm install

# 启动 Electron 与 Vite 开发服务器
pnpm dev

# 验证项目
pnpm check

# 构建生产代码
pnpm build
```

其他打包命令：

```powershell
# 生成未封装应用目录
pnpm package

# 生成当前平台的可分发产物
pnpm dist
```

Electron Builder 在 Windows 上生成 NSIS 安装包和 portable 可执行文件，在 macOS 上生成 DMG，在 Linux 上生成 AppImage。Release workflow 构建 Windows x64/arm64、macOS native 以及 Linux x64/arm64 产物。

## 安全不变量

1. **Renderer 无法读取已存储的 API 密钥。** Renderer 可提交用户新输入的密钥，但持久化密钥是只写的，只能获取 `hasApiKey` 或遮蔽字段；网络请求和认证保留在主进程。
2. **不存在明文凭据降级。** 如果操作系统安全存储不可用，AgentBox 会拒绝加载或保存受保护的本地数据。
3. **OpenRouter 路由默认优先隐私。** 新模型配置默认使用 `data_collection: "deny"` 和 `zdr: true`。
4. **工作区操作受作用域限制。** 文件和终端工具相对于会话工作目录运行，拒绝路径穿越，并使用审批策略保护敏感操作。

## 开源许可证

AgentBox 使用 [MIT License](./LICENSE)。
