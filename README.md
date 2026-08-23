# AgentBox

> **私密、强大的多模型 AI 智能体与桌面客户端**  
> 基于 React 19、TypeScript 与 Electron 35 构建，支持 OpenAI / Anthropic / Responses 原生多协议、多文件 Agent 技能生态与 Model Context Protocol (MCP) 外部工具集成。

[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue.svg)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61dafb.svg)](https://react.dev/)
[![Electron](https://img.shields.io/badge/Electron-35-47848F.svg)](https://www.electronjs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

---

## ✨ 核心特性

- 🔒 **本地加密与强沙箱隔离**：渲染进程完全沙箱化，API Key 绝不暴露给前端；数据通过操作系统凭据封装主密钥，采用 **AES-256-GCM** 全程本地加密落盘。
- 🌐 **多协议与多服务商支持**：将“模型”、“供应商连接”与“协议格式”彻底解耦。统一支持 **OpenAI Chat Completions**、**OpenAI Responses** 与 **Anthropic Messages**，预设 [OpenRouter](https://openrouter.ai/) 与 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 本地高速连接。
- 🛠️ **MCP (Model Context Protocol) 外部工具集成**：
  - 基于官方 MCP TypeScript SDK，支持 **Stdio** 与 **Streamable HTTP**，并兼容旧式 HTTP+SSE 服务。
  - 内置 **BM25 智能工具检索**，根据问题意图动态筛选 Top-K 工具注入上下文，防止 Token 膨胀。
  - 支持最多 6 轮 **Agent 自主多轮执行循环**、会话级服务白名单、敏感操作审批与交互式调用卡片；审批可选择 5 分钟或永不超时，并提供明确警告的 **Full Access** 模式。
- 💻 **跨平台 Integrated terminal shell**：
  - 自动适配 Windows PowerShell/cmd、macOS zsh/bash 与 Linux SHELL/bash/zsh/fish/sh，也可指定 Shell 可执行文件及逐行启动参数。
  - Agent 可通过受审批保护的 `agentbox_run_terminal` 执行命令；自定义 Shell 可用 `{command}` 参数模板适配不同命令行接口。
- 📁 **会话工作目录与开发环境**：
  - 每个会话绑定独立工作目录，新会话继承当前目录或全局默认目录；侧边栏自动按完整目录归组，终端与项目相对路径以该目录为边界。
  - 可配置默认 JDK、Go、PHP 与 Python；Python 支持项目 `.venv`/`venv` 自动发现、系统解释器、普通 venv、Conda 环境名称/prefix 和自定义解释器。
- 🧩 **Agent 多文件技能（Skills）系统**：
  - 采用 Markdown 规范 + **Python 3 / Shell 参考脚本** 标准，支持会话固定、`$skill-id` 显式调用、上下文自动检索和模型按需加载；回答会显示本轮实际激活的技能。
  - 内置受审批保护的 `agentbox_run_code`：JavaScript 在隔离 Worker 中运行，Python 在本机解释器可用时以受限模式运行；技能包脚本本身不会被隐式执行。
  - 支持以 **.zip 压缩包** 形式一键导出与导入外部技能，内置 5 大专业领域预置技能。
- 📐 **Markdown 与 LaTeX 数学公式渲染**：聊天气泡支持自然换行；全面支持行内公式、独立块级公式、矩阵/方程组对齐环境与代码块高亮，具备横向滚动防溢出。
- 🖼️ **多模态与智能附件**：支持文件拖拽、剪贴板粘贴与图片智能尺寸优化（最大 2048px），原生适配各协议图片/文档块并提供高清灯箱预览。
- 🌲 **树状会话与分支版本管理**：支持历史消息就地编辑、重新生成，并在多个回答版本间自由分页切换。
- 🧠 **思考模式与联网搜索**：支持 OpenRouter / Gemini / Claude 深度思考内容与用量归一化；支持 OpenRouter 结构化联网搜索与来源引用。

---

## 📚 详细技术文档中心

项目按模块整理了详尽的技术设计与开发文档，请查阅 [`docs/`](./docs/README.md) 目录：

- 🏛️ [系统架构与进程隔离](./docs/architecture.md)
- 🔐 [加密存储与 Vault 安全设计](./docs/storage-and-vault.md)
- 🌐 [API 协议适配与网关流式处理](./docs/gateway-and-protocols.md)
- 🧩 [Agent 技能（Skills）系统与 Zip 生态](./docs/skills-system.md)
- 🔌 [MCP 外部工具协议与智能检索](./docs/mcp-integration.md)
- 🖥️ [前端 UI、公式渲染与树状会话](./docs/ui-and-components.md)
- 🧪 [开发指南、测试规范与打包发布](./docs/development-and-testing.md)

---

## 🚀 快速开始

### 环境准备

- **Node.js**: 22.0.0 或更高版本
- **pnpm**: 10.0.0 或更高版本（强制使用 pnpm 管理依赖）
- **系统凭据后端**：Windows Credential Protection、macOS Keychain 或 Linux Secret Service

### 安装与运行

```powershell
# 1. 克隆仓库并安装依赖
git clone https://github.com/your-username/agent-box.git
cd agent-box
pnpm install

# 2. 启动本地开发环境 (Vite + Electron)
pnpm dev

# 3. 运行类型检查与自动化测试
pnpm typecheck
pnpm test

# 4. 构建生产应用产物
pnpm build
```

Windows `pnpm dist` 会同时生成引导式 `Setup` 安装包和 portable 免安装版本；
`Setup` 启动后需经安装向导确认，并支持选择安装目录。

---

## 🔒 安全不变量

1. **Renderer 永远无法读取 API Key 明文**：前端只能获知 `hasApiKey: boolean`，所有网络通信与签名均由 Electron 主进程完成。
2. **拒绝无凭据明文降级**：若系统无法提供安全的凭据存储，应用将拒绝保存敏感数据，防止数据意外以明文泄露。
3. **安全默认路由**：OpenRouter 连接默认开启 `deny`（拒绝数据留存）与 `zdr: true`（零数据保留）上游路由偏好。

---

## 📄 开源许可证

本项目采用 [MIT License](./LICENSE) 授权许可。
