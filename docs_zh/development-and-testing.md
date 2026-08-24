# 7. 开发、测试与持续集成

> [English version](../docs/development-and-testing.md) · [返回中文文档索引](./README.md)

本文档说明当前 `package.json`、Vitest、electron-vite、electron-builder 与 GitHub Actions 的实际配置。仓库使用 pnpm；不要用 npm 或 Yarn 重写 `pnpm-lock.yaml`。

## 开发命令

CI 当前以 Node.js 20 和 pnpm 9 为基线。仓库尚未通过 `engines` 或 `packageManager` 字段强制本地版本，排查环境差异时应优先与 CI 对齐。

| 命令 | 实际行为 |
| --- | --- |
| `pnpm install` | 安装依赖；CI 使用 `pnpm install --frozen-lockfile` |
| `pnpm dev` | 通过 `electron-vite dev` 启动 renderer 开发服务器和 Electron |
| `pnpm preview` | 预览已经生成的 electron-vite 构建 |
| `pnpm typecheck` | 分别以 `tsconfig.node.json` 和 `tsconfig.web.json` 检查 main/preload/shared 与 renderer，不生成文件 |
| `pnpm test` | 以 `vitest run` 单次运行全部测试 |
| `pnpm test:watch` | 以 Vitest watch 模式运行受影响测试 |
| `pnpm build` | 先运行 `pnpm typecheck`，再执行 `electron-vite build` |
| `pnpm package` | 先构建，再以 `electron-builder --dir` 生成未封装应用目录 |
| `pnpm dist` | 先构建，再为当前平台生成 electron-builder 分发产物 |

## 构建产物与打包冒烟测试

Electron main 与 sandboxed preload 都显式输出 CommonJS，入口分别为 `out/main/index.cjs` 与 `out/preload/index.cjs`；`package.json#main` 必须保持为 `./out/main/index.cjs`。main 构建会内联 `undici`，其他运行时依赖通常由 electron-vite 外置。

不能只用 `pnpm build` 判断打包后的应用可启动：开发目录能够解析的外置依赖，进入 `app.asar` 后可能暴露 CommonJS/ESM 解析差异。调整 electron-vite 配置、入口或运行时依赖后，应运行：

```powershell
pnpm package
```

随后实际启动当前平台的 unpacked 应用。在 Windows 上检查 `release/win-unpacked/AgentBox.exe` 是否能创建主窗口和 renderer 进程。Windows 分发同时配置 NSIS 引导式安装包与 portable `.exe`；macOS 为 `.dmg`，Linux 为 `.AppImage`。

## Vitest 测试体系

[`vitest.config.ts`](../vitest.config.ts) 默认使用 Node 环境，同时匹配 `tests/**/*.test.ts` 与 `tests/**/*.test.tsx`。适合单测的 renderer 行为仍应尽量拆成纯函数。Renderer 集成测试通过文件级配置启用 jsdom，使用 Testing Library 渲染真实 React 组件，并以进程内 mock 替换 `window.agentbox` preload bridge；它们不属于完整 Electron UI 自动化。由于这些测试会导入真实组件图，`tsconfig.node.json` 纳入完整 renderer 源码树；`.ts` 与 `.tsx` 测试都会参加 TypeScript 检查。

| 范围 | 代表性测试 |
| --- | --- |
| 进程、安全与外部输入边界 | `gateway-safety`, `encrypted-store-safety`, `repository-validation`, `provider-policy`, `proxy-masking` |
| 三种 API、SSE 与联网元数据 | `protocol-adapters`, `sse`, `stream-helper`, `web-metadata-schema`, `web-search-helper` |
| Vault、Schema、迁移、配额与备份 | `settings-schema`, `vault-legacy-migration`, `vault-resource-limits`, `clear-conversations`, `backup-export` |
| Agent、MCP、Skills 与代码执行 | `agent-runtime`, `agent-continuation`, `gateway-mcp-loop`, `mcp-manager`, `mcp-schema`, `tool-retriever`, `skills-management`, `builtin-agent-tools`, `code-executor` |
| renderer 纯逻辑 | `conversation-tree`, `context-projection`, `context-window`, `composer-helper`, `file-helper`, `markdown-helper`, `title-generation`, `token-step`, `workspace-grouping` |
| renderer 集成 | `app.integration`, `settings-dialog.integration`：通过 mock preload bridge 验证应用快捷键、流式更新及 Settings 暂存保存/取消语义 |
| 国际化 | `i18n`：英文为 key 的资源结构、占位符一致、逃生舱解析、locale 决策、英文术语规则和内置 Skill 本地化 |

涉及外部数据的测试至少应覆盖正常路径、功能关闭状态、旧字段缺失、非法或超大输入，以及取消/失败路径。协议改动需覆盖所有受影响的 API 格式，不能只验证单一 provider。

## 提交前验证

普通代码改动至少运行：

```powershell
pnpm test
pnpm build
```

`pnpm build` 已包含类型检查，但不包含测试。涉及打包入口、依赖外置、preload 或 Electron 启动生命周期时，额外执行 `pnpm package` 和 unpacked 应用冒烟测试。

## GitHub Actions

当前 [`.github/workflows/release.yml`](../.github/workflows/release.yml) 在匹配 `v*.*.*` 的 tag 推送或手动 `workflow_dispatch` 时运行：

- Windows：x64 与 arm64；
- macOS：runner 原生架构；
- Ubuntu：x64 与 arm64。

每个 job 安装 pnpm 9、Node.js 20 和冻结锁文件依赖，运行 `pnpm build`，再执行 `electron-builder --publish never`，最后把 `release/*.exe`、`release/*.dmg` 和 `release/*.AppImage` 上传为 GitHub Actions artifact。

该工作流目前**不会运行 `pnpm test`，也不会创建或发布 GitHub Release**。因此测试仍是本地/代码审查阶段的必要门禁；若产品流程要求自动发布 Release，需要另行增加测试与 release publishing 步骤，不能把 artifact upload 误认为正式发布。
