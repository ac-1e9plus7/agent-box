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

---

## 🧪 自动化测试体系（Vitest）

测试套件位于 `tests/` 目录下，采用 Vitest 进行高速测试，覆盖核心安全性与协议逻辑：

| 测试文件 | 覆盖模块 |
| --- | --- |
| `tests/mcp-schema.test.ts` | MCP 服务配置校验与 Vault CRUD 隔离 |
| `tests/mcp-manager.test.ts` | Stdio 真实子进程通信、JSON-RPC 协议与连接池 |
| `tests/tool-retriever.test.ts` | BM25 关键词评分算法与 Top-K 检索排序 |
| `tests/gateway-mcp-loop.test.ts` | Agent 模式多轮 Tool Call 自主执行循环与事件流 |
| `tests/protocol-adapters.test.ts` | OpenAI / Responses / Anthropic 三协议 SSE 流式解析 |
| `tests/encrypted-store-safety.test.ts` | AES-256-GCM 加密、认证标签与 safeStorage 封装 |
| `tests/skills-management.test.ts` | 多文件技能解析、Zip 导入导出与 Frontmatter 提取 |
| `tests/conversation-tree.test.ts` | 树状会话分支切换与版本分页 |

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
