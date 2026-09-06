# 7. Development, Testing, and Continuous Integration

> [简体中文版本](../docs_zh/development-and-testing.md) · [Back to the English documentation index](./README.md)

This document reflects the current `package.json`, Vitest, electron-vite, electron-builder, and GitHub Actions configuration. The repository uses pnpm; do not rewrite `pnpm-lock.yaml` with npm or Yarn.

## Development commands

CI currently uses Node.js 24 and pnpm 11.24.0 as its baseline. The repository requires Node.js 24 or later through `engines` and pins pnpm through `packageManager`; matching those versions is the first step when investigating environment-specific behavior. Node.js 25+ no longer distributes Corepack, so a Node 25+ developer must install standalone Corepack or otherwise make pnpm 11.24.0 available rather than assuming `corepack enable` exists.

| Command             | Current behavior                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`      | Install dependencies; CI uses `pnpm install --frozen-lockfile`                                                                                                                                                            |
| `pnpm dev`          | Start Electron and the renderer development server through `electron-vite dev`                                                                                                                                            |
| `pnpm preview`      | Preview an existing electron-vite build                                                                                                                                                                                   |
| `pnpm typecheck`    | Check main/preload/shared with `tsconfig.node.json` and the renderer with `tsconfig.web.json`, without emitting JavaScript or declaration files; composite TypeScript projects may refresh ignored `*.tsbuildinfo` caches |
| `pnpm lint`         | Run ESLint with TypeScript type information and fail on warnings                                                                                                                                                          |
| `pnpm lint:fix`     | Apply ESLint's safe automatic fixes                                                                                                                                                                                       |
| `pnpm format`       | Format supported source, configuration, stylesheet, and documentation files with Prettier                                                                                                                                 |
| `pnpm format:check` | Verify Prettier formatting without modifying files                                                                                                                                                                        |
| `pnpm test`         | Run the complete test suite once through `vitest run`                                                                                                                                                                     |
| `pnpm test:watch`   | Run Vitest in watch mode                                                                                                                                                                                                  |
| `pnpm check`        | Run type checking, linting, formatting, localization checks, and the complete test suite                                                                                                                                  |
| `pnpm build`        | Run `pnpm typecheck`, then `electron-vite build`                                                                                                                                                                          |
| `pnpm package`      | Build, then produce an unpacked application with `electron-builder --dir`                                                                                                                                                 |
| `pnpm dist`         | Build, then produce electron-builder distributables for the current platform                                                                                                                                              |

## Build output and packaged smoke tests

Both the Electron main process and sandboxed preload are emitted explicitly as CommonJS. Their entry points are `out/main/index.cjs` and `out/preload/index.cjs`; `package.json#main` must remain aligned at `./out/main/index.cjs`. The main build bundles `undici`, while electron-vite normally externalizes other runtime dependencies.

A successful `pnpm build` is not sufficient evidence that the packaged application starts. A dependency that resolves from the development directory can still expose CommonJS/ESM resolution differences from inside `app.asar`. After changing electron-vite settings, entry points, or runtime dependencies, run:

```powershell
pnpm package
```

Then launch the unpacked application for the current platform. On Windows, verify that `release/win-unpacked/AgentBox.exe` creates both the main window and renderer process. Windows distribution targets include a guided NSIS installer and a portable `.exe`; macOS targets `.dmg`, and Linux targets `.AppImage`.

## Vitest test system

[`vitest.config.ts`](../vitest.config.ts) uses the Node environment by default and matches both `tests/**/*.test.ts` and `tests/**/*.test.tsx`. Pure renderer behavior remains isolated in testable functions where practical. Renderer integration tests opt into jsdom at the file level and render real React components with Testing Library; `app.integration` and `browser-panel.integration` install a typed in-memory `window.agentbox` preload-bridge mock, while `settings-dialog.integration` and `chat-content-usage` exercise component props/callbacks without crossing that bridge. They are not full Electron UI automation. `tsconfig.node.json` includes the complete renderer source tree because these tests import real component graphs, and both `.ts` and `.tsx` tests participate in TypeScript checking.

| Area                                                    | Representative tests                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process, security, and untrusted-input boundaries       | `gateway-safety`, `encrypted-store-safety`, `repository-validation`, `provider-policy`, `proxy-masking`, `browser-policy`                                                                                                                                                                                                                                                              |
| Three APIs, SSE, usage, context reuse, and web metadata | `protocol-adapters`, `token-usage`, `provider-context-optimization`, `gateway-provider-context`, `sse`, `stream-helper`, `web-metadata-schema`, `web-search-helper`                                                                                                                                                                                                                    |
| Vault, schemas, migrations, quotas, and backups         | `settings-schema`, `vault-legacy-migration`, `vault-resource-limits`, `clear-conversations`, `backup-export`                                                                                                                                                                                                                                                                           |
| Agent, MCP, Skills, checkpoints, browser, and execution | `agent-runtime`, `langgraph-agent-runtime`, `agentbox-checkpoint-saver`, `encrypted-record-namespace`, `checkpoint-lifecycle`, `agent-continuation`, `agent-token-optimization`, `gateway-mcp-loop`, `mcp-manager`, `mcp-schema`, `tool-retriever`, `skills-management`, `builtin-agent-tools`, `browser-manager`, `browser-tool-executor`, `browser-snapshot-script`, `code-executor` |
| Pure renderer logic                                     | `conversation-tree`, `context-projection`, `context-window`, `composer-helper`, `file-helper`, `markdown-helper`, `title-generation`, `token-step`, `workspace-grouping`                                                                                                                                                                                                               |
| Renderer integration                                    | `app.integration`, `settings-dialog.integration`, `chat-content-usage`, `browser-panel.integration`: application shortcuts, streaming updates, browser tab controls, usage rendering, and staged Settings save/cancel behavior against a mocked preload bridge                                                                                                                         |
| Localization                                            | `i18n`: English-source-key bundle shape, placeholder parity, hatch-key resolution, locale selection, terminology on English keys, and localized built-in Skills                                                                                                                                                                                                                        |

Tests around external input should cover the normal path, disabled behavior, missing legacy fields, malformed or oversized values, and cancellation/failure paths. A protocol change must cover every affected API format rather than only one provider.

The built-in browser additionally requires an unpacked Electron smoke test because jsdom cannot instantiate `WebContentsView` or Chromium sessions. Exercise controlled fixtures for multiple tabs and window-open conversion, semantic snapshots, screenshots, encrypted Cookie restore, stale references, upload/download enablement and limits, popup/permission denial, renderer failure, view hiding under trusted dialogs, session cleanup, and optional loopback HTTP. Browser lifecycle changes follow the same `pnpm package` and unpacked-application launch requirement as preload and entry-point changes.

## Pre-commit verification

For ordinary code changes, run at least:

```powershell
pnpm check
pnpm build
```

`pnpm check` is the source-non-mutating quality gate: it does not rewrite application source, but its composite TypeScript checks may refresh ignored `*.tsbuildinfo` caches. Use `pnpm lint:fix` and `pnpm format` to apply automatic fixes before rerunning it. Generated locale bundles and package-manager lock data remain excluded from Prettier so their generators stay authoritative. `pnpm build` includes type checking but does not include the other checks. Changes to packaging entry points, dependency externalization, preload, or the Electron startup lifecycle also require `pnpm package` and an unpacked-application smoke test.

## GitHub Actions

The [quality workflow](../.github/workflows/quality.yml) runs `pnpm check` for branch pushes and pull requests. The [release workflow](../.github/workflows/release.yml) runs for tags matching `v*.*.*` and for manual `workflow_dispatch` events. Its build matrix is:

- Windows x64 and arm64;
- macOS on the runner's native architecture;
- Ubuntu x64 and arm64.

Each release job installs pnpm 11.24.0 and Node.js 24, installs dependencies with the frozen lockfile, runs `pnpm check` and `pnpm build`, invokes `electron-builder --publish never`, and uploads `release/*.exe`, `release/*.dmg`, and `release/*.AppImage` as GitHub Actions artifacts. Matrix fail-fast is disabled so one platform failure does not hide results from the others.

After every platform succeeds for a pushed version tag, the publish job downloads the build artifacts, adds platform and architecture suffixes to avoid filename collisions, and creates or updates the matching GitHub Release with the packaged assets. Manual `workflow_dispatch` runs build artifacts only and do not publish a Release.

## data-plat

The data-plat-* suites cover schema dialects, encrypted configuration, exact approval, operation recovery, UI markers, and actual SDK HTTP transport against a local fixture. Run them as part of pnpm check. Companion package/platform integration tests remain separate. See [data-plat integration](data-plat-integration.md).

## Explicit Python runtime verification

Set `AGENTBOX_TEST_PYTHON` to a real Python 3 executable and run `pnpm exec vitest run tests/python-runtime-live.test.ts`. It verifies structured `input_data` calculations, blocked file/module access, and timeout termination. Without this variable the three optional live cases are skipped; CI can set it to its installed Python path. On Windows the runner waits for process/stdio closure before deleting its temporary directory, with bounded retries for transient file locks.
