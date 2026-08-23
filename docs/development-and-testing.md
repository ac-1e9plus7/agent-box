# 7. 开发、测试与持续集成

本文档汇总了 AgentBox 的工程化配置、测试规范与跨平台构建流水线。

---

## 🛠️ 常用开发命令

本项目强制使用 **pnpm** 作为包管理器（禁止使用 npm 或 Yarn 改写锁文件）：

```powershell
# 依赖安装
pnpm install

# 启动本地开发环境 (Vite Dev Server + Electron Main)
pnpm dev

# TypeScript 全局类型检查 (Main, Preload, Shared, Renderer)
pnpm typecheck

# 运行自动化单元与集成测试 (Vitest)
pnpm test

# 生产环境完整构建验证
pnpm build

# 打包未封装应用目录 (用于本地冒烟测试)
pnpm package

# 生成当前平台的可分发安装包 (NSIS, DMG, AppImage)
pnpm dist
```

Windows 的 `Setup` 产物使用 NSIS 引导式安装：双击启动后需要在向导中确认
安装范围和安装选项，随后可自行选择安装目录，再进入实际安装阶段。构建同时
保留免安装的 portable `.exe`，其启动行为不经过安装向导。

Electron main 与 sandboxed preload 都显式输出 CommonJS：入口分别为
`out/main/index.cjs` 和 `out/preload/index.cjs`。`package.json#main` 必须与 main
产物同步。这里不能只依赖 `pnpm build` 验证；外置依赖在开发目录中可被正常
解析，但 Windows 的 ESM main 打入 `app.asar` 后可能无法解析 `ajv` 等传统
CommonJS 包入口。因此调整 Electron/Vite 配置、入口文件或运行时依赖后，还要
执行 `pnpm package` 并实际启动 `release/win-unpacked/AgentBox.exe`，确认主窗口
出现且 renderer 进程成功创建。

---

## 🧪 自动化测试体系（Vitest）

测试套件位于 `tests/` 目录下，采用 Vitest 进行高速测试，覆盖核心安全性与协议逻辑：

| 测试文件 | 覆盖模块 |
| --- | --- |
| `tests/mcp-schema.test.ts` | MCP 服务配置校验与 Vault CRUD 隔离 |
| `tests/mcp-manager.test.ts` | Stdio 真实子进程通信、JSON-RPC 协议与连接池 |
| `tests/tool-retriever.test.ts` | BM25 关键词评分算法与 Top-K 检索排序 |
| `tests/builtin-agent-tools.test.ts` | 内置 Agent 工具目录、工作区文件工具与技能条件挂载 |
| `tests/gateway-mcp-loop.test.ts` | Agent 模式多轮 Tool Call 自主执行循环与事件流 |
| `tests/protocol-adapters.test.ts` | OpenAI / Responses / Anthropic 三协议 SSE 流式解析 |
| `tests/encrypted-store-safety.test.ts` | AES-256-GCM 加密、认证标签与 safeStorage 封装 |
| `tests/skills-management.test.ts` | 多文件技能解析、Zip 导入导出与 Frontmatter 提取 |
| `tests/conversation-tree.test.ts` | 树状会话分支切换与版本分页 |
| `tests/backup-export.test.ts` | 浅/深会话 ZIP、清单、AES-256 密码、工作目录去重与失败清理 |

### 提交前验证规范
在提交任何代码改动前，必须确保以下两步 100% 通过：
```powershell
pnpm test
pnpm build
```

---

## 🚀 跨平台 CI/CD 打包流水线

项目已配置 GitHub Actions 工作流（`.github/workflows/release.yml`）：
- 当推送发布标签（如 `v*`）时，自动在 **Windows**、**macOS** 与 **Linux** 原生运行器上并行执行构建。
- 自动生成 Windows 安装包（`.exe`）、macOS 镜像（`.dmg`）与 Linux 软件包（`.AppImage`），并自动发布至 GitHub Releases。
