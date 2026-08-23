# 7. Development, Testing, and Continuous Integration

> [简体中文版本](../docs_zh/development-and-testing.md) · [Back to the English documentation index](./README.md)

This document reflects the current `package.json`, Vitest, electron-vite, electron-builder, and GitHub Actions configuration. The repository uses pnpm; do not rewrite `pnpm-lock.yaml` with npm or Yarn.

## Development commands

CI currently uses Node.js 20 and pnpm 9 as its baseline. The repository does not yet enforce local versions through `engines` or `packageManager`, so matching the CI versions is the first step when investigating environment-specific behavior.

| Command | Current behavior |
| --- | --- |
| `pnpm install` | Install dependencies; CI uses `pnpm install --frozen-lockfile` |
| `pnpm dev` | Start Electron and the renderer development server through `electron-vite dev` |
| `pnpm preview` | Preview an existing electron-vite build |
| `pnpm typecheck` | Check main/preload/shared with `tsconfig.node.json` and the renderer with `tsconfig.web.json`, without emitting files |
| `pnpm test` | Run the complete test suite once through `vitest run` |
| `pnpm test:watch` | Run Vitest in watch mode |
| `pnpm build` | Run `pnpm typecheck`, then `electron-vite build` |
| `pnpm package` | Build, then produce an unpacked application with `electron-builder --dir` |
| `pnpm dist` | Build, then produce electron-builder distributables for the current platform |

## Build output and packaged smoke tests

Both the Electron main process and sandboxed preload are emitted explicitly as CommonJS. Their entry points are `out/main/index.cjs` and `out/preload/index.cjs`; `package.json#main` must remain aligned at `./out/main/index.cjs`. The main build bundles `undici`, while electron-vite normally externalizes other runtime dependencies.

A successful `pnpm build` is not sufficient evidence that the packaged application starts. A dependency that resolves from the development directory can still expose CommonJS/ESM resolution differences from inside `app.asar`. After changing electron-vite settings, entry points, or runtime dependencies, run:

```powershell
pnpm package
```

Then launch the unpacked application for the current platform. On Windows, verify that `release/win-unpacked/AgentBox.exe` creates both the main window and renderer process. Windows distribution targets include a guided NSIS installer and a portable `.exe`; macOS targets `.dmg`, and Linux targets `.AppImage`.

## Vitest test system

[`vitest.config.ts`](../vitest.config.ts) uses the Node environment by default and matches both `tests/**/*.test.ts` and `tests/**/*.test.tsx`. Pure renderer behavior remains isolated in testable functions where practical. Renderer integration tests opt into jsdom at the file level, render the real React components with Testing Library, and replace `window.agentbox` with an in-memory preload-bridge mock; they are not full Electron UI automation. `tsconfig.node.json` includes the complete renderer source tree because these tests import real component graphs, and both `.ts` and `.tsx` tests participate in TypeScript checking.

| Area | Representative tests |
| --- | --- |
| Process, security, and untrusted-input boundaries | `gateway-safety`, `encrypted-store-safety`, `repository-validation`, `provider-policy`, `proxy-masking` |
| Three APIs, SSE, and web metadata | `protocol-adapters`, `sse`, `stream-helper`, `web-metadata-schema`, `web-search-helper` |
| Vault, schemas, migrations, quotas, and backups | `settings-schema`, `vault-legacy-migration`, `vault-resource-limits`, `clear-conversations`, `backup-export` |
| Agent, MCP, Skills, and code execution | `agent-runtime`, `agent-continuation`, `gateway-mcp-loop`, `mcp-manager`, `mcp-schema`, `tool-retriever`, `skills-management`, `builtin-agent-tools`, `code-executor` |
| Pure renderer logic | `conversation-tree`, `context-projection`, `context-window`, `composer-helper`, `file-helper`, `markdown-helper`, `title-generation`, `token-step`, `workspace-grouping` |
| Renderer integration | `app.integration`, `settings-dialog.integration`: application shortcuts, streaming updates, and staged Settings save/cancel behavior against a mocked preload bridge |
| Localization | `i18n`: bundle shape, placeholders, locale selection, terminology rules, and localized built-in Skills |

Tests around external input should cover the normal path, disabled behavior, missing legacy fields, malformed or oversized values, and cancellation/failure paths. A protocol change must cover every affected API format rather than only one provider.

## Pre-commit verification

For ordinary code changes, run at least:

```powershell
pnpm test
pnpm build
```

`pnpm build` includes type checking but does not include tests. Changes to packaging entry points, dependency externalization, preload, or the Electron startup lifecycle also require `pnpm package` and an unpacked-application smoke test.

## GitHub Actions

The current [`.github/workflows/release.yml`](../.github/workflows/release.yml) runs for tags matching `v*.*.*` and for manual `workflow_dispatch` events. Its build matrix is:

- Windows x64 and arm64;
- macOS on the runner's native architecture;
- Ubuntu x64 and arm64.

Each job installs pnpm 9 and Node.js 20, installs dependencies with the frozen lockfile, runs `pnpm build`, invokes `electron-builder --publish never`, and uploads `release/*.exe`, `release/*.dmg`, and `release/*.AppImage` as GitHub Actions artifacts.

The workflow currently **does not run `pnpm test` and does not create or publish a GitHub Release**. Tests therefore remain a required local/review gate. If the product workflow is expected to publish releases automatically, test and release-publishing steps must be added explicitly; artifact upload alone is not a release.
