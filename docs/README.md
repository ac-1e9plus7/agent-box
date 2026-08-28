# AgentBox Technical Documentation

> [简体中文文档](../docs_zh/README.md) · [Back to the English project README](../README.md)

This documentation set describes AgentBox's current design, boundaries, and maintenance requirements by code module. When behavior, interfaces, schemas, limits, or build workflows change, update the corresponding English and Chinese documents together.

## Documentation index

| #   | Document                                                                         | Scope                                                                                                                             | Primary source                                                                     |
| --- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | [System architecture](./architecture.md)                                         | Electron process model, sandbox, preload/IPC boundaries, windows, and external-link lifecycle                                     | `src/electron/main.ts`, `src/electron/preload.ts`, `src/shared/ipc.ts`             |
| 2   | [Encrypted storage and Vault security](./storage-and-vault.md)                   | safeStorage, AES-256-GCM, schemas, quotas, data clearing, and ZIP backups                                                         | `src/electron/storage/`, `src/electron/backup/`                                    |
| 3   | [API protocols and request gateway](./gateway-and-protocols.md)                  | OpenAI Chat Completions API, OpenAI Responses API, Anthropic Messages API, SSE, reasoning, web search, and proxies                | `src/electron/api/`                                                                |
| 4   | [Agent Skills system](./skills-system.md)                                        | Multi-file Skills, built-ins, ZIP import/export, retrieval, and dynamic prompt augmentation                                       | `src/electron/storage/default-skills.ts`, `src/shared/skill-zip.ts`                |
| 5   | [MCP tools and retrieval](./mcp-integration.md)                                  | stdio, Streamable HTTP, legacy HTTP+SSE, connection pooling, retrieval, approvals, and multi-turn Agent execution                 | `src/electron/mcp/`, `src/electron/api/gateway.ts`                                 |
| 6   | [Renderer UI and interactions](./ui-and-components.md)                           | React renderer, message trees, Markdown/KaTeX, attachments, profiles, and keyboard behavior                                       | `src/renderer/src/`, `src/shared/conversation-tree.ts`                             |
| 7   | [Development, testing, and CI](./development-and-testing.md)                     | pnpm scripts, Vitest, CommonJS packaging constraints, smoke tests, and GitHub Actions                                             | `package.json`, `tests/`, `.github/workflows/`                                     |
| 8   | [Conversation workspaces and development runtimes](./workspaces-and-runtimes.md) | Workspace boundaries, integrated terminal, JDK/Go/PHP/Python, venv, and Conda                                                     | `src/electron/api/runtime-environments.ts`, `src/renderer/src/workspace-groups.ts` |
| 9   | [Localization and English terminology](./i18n.md)                                | First-launch language selection, English-source-key bundles, generation, the `check` linter, semantic hatch keys, and terminology | `src/shared/i18n/`, `scripts/localize-renderer.mjs`                                |
| 10  | [LangGraph Agent Runtime](./langgraph-agent-runtime.md)                          | Current Agent state machine, Gateway callback boundary, streaming, cancellation, checkpoint routing, and security                 | `src/electron/api/gateway.ts`, `src/electron/api/agent-runtime.ts`                 |
| 11  | [Encrypted LangGraph checkpoints](./langgraph-checkpoints.md)                    | Encrypted record sidecar, `BaseCheckpointSaver`, message artifacts, quotas, lifecycle deletion, and recovery                      | `src/electron/storage/`, `src/electron/api/agent-runtime.ts`                       |

## Core maintenance principles

1. **Process isolation:** Keep the renderer at `sandbox: true`, `contextIsolation: true`, and `nodeIntegration: false`. Secrets, network calls, encrypted persistence, and system-process operations belong only in the main process.
2. **Separate product entities from protocols:** Providers, models, and API formats are distinct entities. The gateway normalizes all three upstream API families into shared request and event types.
3. **Protect local data:** The Vault uses AES-256-GCM and wraps its data key with OS secure storage. Never fall back to plaintext when secure storage is unavailable.
4. **Enforce workspace boundaries:** Agent file and execution tools operate only under a conversation's absolute working directory and reject symbolic-link escapes.
5. **Keep both languages synchronized:** The root READMEs, both documentation indexes, and all module documents have language counterparts. Product-copy changes also require synchronized resource bundles and localization tests.
