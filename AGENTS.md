# AGENTS.md

> Synchronization contract: This file and [`CLAUDE.md`](./CLAUDE.md) define the same repository instructions. Any change to either file must update the other in the same change. Apart from the filename heading and reciprocal link, keep their rules semantically identical.

This file defines repository-level instructions for coding agents working on AgentBox. Read it before making changes. The user's current request always takes precedence over this file.

## Start here

Before editing:

1. Read this file and the default English [`README.md`](./README.md).
2. Read the English document under [`docs/`](./docs/README.md) for every module you will touch. Use the matching file under [`docs_zh/`](./docs_zh/README.md) when maintaining the Chinese version.
3. Inspect the current implementation and tests. Documentation is guidance, not a substitute for source code.
4. Check `git status`. Existing edits belong to the user unless you know otherwise; preserve unrelated changes and avoid broad formatting churn.

When requirements conflict, follow this order: the current user request, platform or safety constraints, this file, then module documentation.

## Project snapshot

AgentBox is a local-first desktop AI client and Agent application built with React 19, TypeScript 5.7, Electron 35, Vite 5.4, and electron-vite 3.

The application separates:

- providers and credentials;
- model configuration;
- wire formats: OpenAI Chat Completions API, OpenAI Responses API, and Anthropic Messages API;
- conversations, Agent Skills, MCP servers, and working directories.

Core invariants:

- The renderer owns presentation and transient interaction state. Provider requests, encrypted persistence, secret access, and system-process operations belong in the Electron main process.
- Persisted API keys are write-only from the renderer's perspective. The renderer may submit a newly entered key, but no IPC response may return a stored key.
- Vault data is encrypted locally. There is no plaintext fallback when OS secure storage is unavailable.
- Older valid Vaults must remain readable. New validation must not silently replace user settings or make deletion/recovery paths unavailable.

## Tooling and commands

The CI baseline is Node.js 24 and pnpm 11.24.0. `package.json#engines` requires Node.js 24 or later, while `package.json#packageManager` pins pnpm; use Corepack or the exact pinned versions when installing dependencies or diagnosing environment-specific issues.

Use pnpm for repository dependency and script operations. Do not use npm or Yarn to rewrite `pnpm-lock.yaml`; prefer `pnpm exec` over `npx` for project-local binaries.

```powershell
pnpm install
pnpm dev
pnpm preview
pnpm typecheck
pnpm lint
pnpm lint:fix
pnpm format
pnpm format:check
pnpm test
pnpm test:watch
pnpm i18n:generate
pnpm i18n:check
pnpm check
pnpm build
pnpm package
pnpm dist
```

- `pnpm typecheck` checks main, preload, shared, renderer, and tests without emitting files.
- `pnpm lint` runs type-aware ESLint and fails on warnings; `pnpm lint:fix` applies safe automatic fixes.
- `pnpm format` writes Prettier formatting; `pnpm format:check` verifies it without modifying files.
- `pnpm test` runs the Vitest suite once.
- `pnpm check` is the non-mutating quality gate: type checking, linting, formatting, localization validation, and the complete test suite.
- `pnpm build` runs type checking and creates production bundles; it does not run tests.
- `pnpm package` creates an unpacked application directory.
- `pnpm dist` creates distributable artifacts for the current platform.

For ordinary code changes, run focused tests while iterating and finish with `pnpm check` and `pnpm build`. Packaging, preload, entry-point, dependency-externalization, or Electron lifecycle changes also require `pnpm package` and an actual unpacked-application smoke test.

The GitHub quality workflow runs `pnpm check` for branch pushes and pull requests. The release workflow installs Node.js 24 and pnpm 11.24.0, runs `pnpm check`, builds and packages a platform matrix, and uploads artifacts. It does not publish a GitHub Release; do not describe artifact upload as a release publication.

## Documentation contract

English is the default repository language for project documentation:

- [`README.md`](./README.md) is the default English overview.
- [`README_zh.md`](./README_zh.md) is the matching Simplified Chinese overview.
- [`docs/`](./docs/README.md) contains the English technical index and nine English module documents.
- [`docs_zh/`](./docs_zh/README.md) contains matching Chinese files with identical filenames.
- `CLAUDE.md` and `AGENTS.md` must remain entirely in English.

Documentation rules:

1. Read the relevant module document before changing behavior:
   - process model, preload, IPC, windows, or external links: `architecture.md`;
   - Vault, settings, schemas, quotas, clearing, or backups: `storage-and-vault.md`;
   - provider requests, response parsing, reasoning, web search, or proxies: `gateway-and-protocols.md`;
   - Agent Skills, retrieval, built-ins, or ZIP import/export: `skills-system.md`;
   - MCP transports, retrieval, approvals, or the Agent tool loop: `mcp-integration.md`;
   - renderer state, conversation trees, Markdown/KaTeX, profiles, or attachments: `ui-and-components.md`;
   - working directories, integrated terminal, or developer runtimes: `workspaces-and-runtimes.md`;
   - localization, resource generation, or terminology: `i18n.md`;
   - scripts, tests, packaging, or CI: `development-and-testing.md`.
2. Behavioral, schema, interface, limit, security, build, or product-copy changes require synchronized updates to both `docs/<name>.md` and `docs_zh/<name>.md`.
3. Keep `README.md` and `README_zh.md` synchronized at a high level. Put implementation detail in the matching technical documents.
4. Preserve reciprocal language links in both root READMEs, both documentation indexes, and every paired document. English README links should lead to `docs/`; Chinese README links should lead to `docs_zh/`.
5. Code examples, Mermaid diagrams, file paths, limits, version requirements, and CI claims must match the current source and configuration.
6. Validate local Markdown links, paired filenames, balanced code fences, and trailing whitespace after documentation changes.

Do not update only one language and leave the counterpart stale. If a term has no useful direct translation, retain the product's official English name in both documents.

## Localization and product terminology

All user-visible copy in the renderer or main process must go through the shared localization layer under `src/shared/i18n/`. **English source copy is the message key**; the Simplified Chinese translations live in `zh-CN.ts`.

- `AppLanguage` currently supports `zh-CN` and `en-US`.
- Author copy in English and pass it to `t('English source text')`. The `key` parameter is typed `MessageKey` (`keyof typeof zhCN`), so typos and references to removed keys surface at compile time.
- `zh-CN.ts` is generated. Do not hand-edit it as the only source change. Update message usage, `reviewedZh`, or `normalizeZhByContext` in `scripts/localize-renderer.mjs`, then run `node scripts/localize-renderer.mjs generate` (and `pnpm i18n:check`).
- The `en-US.ts` bundle holds only semantic "hatch" keys: cases where one English string must render as different Chinese messages (for example the Chinese Agent resume phrases that all read `Continue`/`Try again`). Add a hatch key only when a new same-English/different-Chinese collision appears; otherwise the English key renders as itself.
- Keys and their Chinese values must preserve identical placeholder sets (named `{count}` or positional `{value0}`).
- Dates and numbers shown to users must use `getLanguage()` with `Intl` or `toLocaleString`; do not hard-code `zh-CN`.
- Canonical Simplified Chinese for product terms must be reviewed manually and added to `reviewedZh`. Do not rely on raw machine translation for API names, security copy, or long Skill instructions.
- `node scripts/localize-renderer.mjs check` must pass: it fails on Chinese strings or JSX text outside `t()` (including raw-Chinese fallback values that should be wrapped) and on `t()` keys absent from `zh-CN.ts`.
- Executable Skill assets (`python`, `shell`, and other code files) must never enter language bundles or machine translation. Localize Skill names, descriptions, System Instructions, and `kind === 'markdown'` files only.
- Preserve these official terms: Responses API, Chat Completions API, reasoning effort, adaptive thinking, manual extended thinking, MCP server, MCP tool, Streamable HTTP, legacy HTTP+SSE, provider, provider fallback, Zero Data Retention (ZDR), and native web search.

First-launch language selection and migration are compatibility behavior: locales beginning with `zh` select Simplified Chinese; all other locales select English. The selected language is encrypted in `AppSettings.language`. The main process must set a language before repository initialization, and the renderer must set the stored language before dynamically importing the application.

Run `tests/i18n.test.ts` after localization changes. It checks key/value placeholder parity, terminology on English keys, hatch-key resolution, built-in Skill localization, and exclusion of executable assets.

## Responsibility map

```text
src/shared/                         Cross-process types, IPC names, i18n, limits, and pure helpers
src/shared/i18n/                    Active language, resource lookup, and generated locale bundles
src/shared/token-estimate.ts        Shared token estimation; do not duplicate in main and renderer
src/electron/main.ts                Electron lifecycle, window security, locale bootstrap, external links
src/electron/preload.ts             Minimal, frozen window.agentbox API
src/electron/ipc/register-ipc.ts    IPC registration, sender validation, native dialogs
src/electron/api/gateway.ts         Provider network orchestration, streaming, Agent loop, proxy dispatcher
src/electron/api/request-adapters.ts Request bodies for all three API formats and OpenRouter web search
src/electron/api/protocol-adapters.ts Provider stream/response normalization
src/electron/api/context-window.ts  Complete-turn context trimming using shared token estimates
src/electron/api/code-executor.ts   Restricted JavaScript/Python code execution
src/electron/api/terminal-shell.ts  Integrated terminal resolution and execution
src/electron/api/workspace-files.ts Workspace-scoped file operations
src/electron/mcp/                   MCP clients, transports, manager, approval policy, BM25 retrieval
src/electron/storage/               Encrypted Vault, schemas, repository CRUD, quotas, built-in Skills
src/electron/storage/agentbox-checkpoint-saver.ts Encrypted LangGraph BaseCheckpointSaver adapter
src/electron/storage/checkpoint-repository.ts Encrypted checkpoint manifests, quotas, artifacts, and deletion
src/electron/backup/                Conversation and workspace ZIP backup export
src/renderer/src/App.tsx            Renderer bootstrap, settings persistence, coordination, top-level composition
src/renderer/src/hooks/              Conversation state and normalized chat-stream orchestration
src/renderer/src/components/        React components, dialogs, and the Settings shell
src/renderer/src/components/settings/ Settings sections and shared Settings controls
src/renderer/src/                   Testable renderer helpers for context, titles, files, Markdown, and input
scripts/                            Icon generation and localization extraction/review pipeline
build/                              Source/generated application icons used by packaging
tests/                              Unit and integration tests for boundaries and pure behavior
docs/                               Default English technical documentation
docs_zh/                            Matching Simplified Chinese technical documentation
```

Do not move provider protocol logic, credentials, or persistence into React components. Do not duplicate protocol rules between renderer and main.

## Security invariants

### Secrets and encrypted storage

- Stored API keys may never be returned by IPC. `ProviderView` exposes `hasApiKey`, not the stored value. Mask proxy or MCP secrets before returning configurations to the renderer.
- Never log or snapshot API keys, authentication headers, proxy credentials, the Vault key, complete decrypted Vault state, or unredacted secret-bearing records.
- LangGraph checkpoint files remain inside the Vault security domain. Logical checkpoint IDs use HMAC-derived filenames; checkpoint records, pending writes, message snapshots, and artifacts are AES-256-GCM ciphertext only.
- The Vault uses a random 32-byte key, AES-256-GCM, random 12-byte IVs, authentication tags, and atomic file replacement. The key is wrapped with Electron `safeStorage`.
- Refuse plaintext fallback when `safeStorage` is unavailable or Linux reports the `basic_text` backend. Do not disable this behavior to make development easier.
- Preserve the single-instance lock and secure key lifecycle. Fill sensitive in-memory key buffers on destruction.
- Storage-field changes require synchronized shared types, normalization, repository mutation handling, resource accounting, legacy migration behavior, and tests.

### Electron and IPC

- Keep `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, and `webSecurity: true`.
- Sandboxed preload output must remain CommonJS at `out/preload/index.cjs`. Do not switch it to a top-level-import ESM preload or disable the sandbox to hide preload failures.
- Preload exposes only the deep-frozen `window.agentbox` allowlist.
- IPC must validate the target `WebContents`, require the top-level main frame, and accept only the trusted production file path or configured development origin and pathname.
- Production CSP belongs in `src/renderer/index.html`; a response header cannot protect a `file://` renderer.
- Deny renderer-created windows. Only credential-free `http:` and `https:` URLs revalidated by the main process may be passed to `shell.openExternal`.

### Provider network and proxy behavior

- Remote provider and proxy URLs require HTTPS. Plain HTTP is allowed only for loopback addresses.
- CLIProxyAPI may omit an API key only on loopback. A remote CLIProxyAPI connection requires HTTPS and a key.
- Never send empty `Authorization`, `x-api-key`, or proxy-authorization headers.
- Preserve redirect rejection, request timeouts, cancellation, response/SSE size limits, and bounded error-body reads.
- Redact API keys and proxy userinfo from UI-facing errors. Never expose proxy credentials; do not rely on logs or tests that include full credential-bearing URLs.
- Main-process provider generation, model discovery, and remote MCP HTTP/SSE traffic must apply the configured undici `ProxyAgent`. Do not replace this with `session.setProxy` or Chromium command-line flags; those do not cover main-process fetch calls.
- Proxy configuration remains encrypted in `AppSettings.proxy`; legacy settings without it normalize to disabled.

### Tool and workspace boundaries

- Built-in workspace file tools require a conversation working directory, accept relative paths only, reject traversal and absolute paths, and reject symbolic-link escapes.
- The integrated terminal uses the conversation directory only as its initial `cwd`. It is not an OS sandbox: an approved command can use absolute paths, access other files, start processes, or use the network. Never describe `cwd` as containment.
- The JavaScript/Python code runner is restricted and resource-bounded, but it is not a complete OS security boundary. Code and terminal tools require approval unless Full Access is enabled.
- MCP `ToolAnnotations` are untrusted hints. Treat a tool as explicitly low risk only when it declares read-only, non-destructive, closed-world behavior; otherwise classify it as sensitive.
- Validate every tool argument against JSON and the advertised input JSON Schema. Never execute unknown, unexposed, malformed, or unauthorized tools.
- Skill instructions affect System Instructions and therefore cross a trust boundary. Import and enable only trusted Skills. Reference scripts do not execute automatically.

## Vault compatibility and destructive operations

- The current Vault schema version is 1. Newer fields are generally optional on read and receive conservative defaults through normalization.
- Defaults for new Vaults must not overwrite stored user choices. Do not infer migrations from model IDs or familiar numeric values.
- A normalization that performs a defined legacy migration may be persisted, as with the one-time language migration. Add explicit tests for it.
- Do not add a global load-time quota that rejects previously valid historical data. Aggregate conversation quotas are enforced on save mutations: an already-over-limit Vault must still be able to remain unchanged, shrink, or delete data.
- Deletion and recovery paths must remain available even when other mutations fail validation.
- A failed conversation save must stop the paid model request and restore draft/UI state.

`clearConversations` clears only conversations. It must cancel active streams first and preserve providers, models, settings, credentials, Skills, MCP servers, and the Vault key. It re-encrypts the retained state; it is not forensic media erasure. Document this boundary in both `storage-and-vault.md` language versions.

Conversation backup rules:

- shallow backups contain all conversation branches, messages, attachments, Agent traces, JSON, and readable Markdown;
- deep backups additionally stream unique conversation working directories;
- symbolic links are stored as link entries and are not followed outside a workspace;
- backup content is plaintext inside the ZIP unless a password enables WinZip AES-256 (AE-2);
- API keys, the Vault key, providers, models, MCP servers, Skills, and application settings are excluded.

## Provider protocols and gateway behavior

- OpenAI Chat Completions API uses `/chat/completions` and `choices[].delta` output shapes.
- OpenAI Responses API uses `/responses`, `input`/`instructions`, output items, and Responses events. OpenRouter requests replay the necessary history; preserve provider items and reasoning items required for stateless continuation.
- Anthropic Messages API uses `/messages`, a top-level `system`, and Anthropic content blocks.
- Convert all provider events into shared `StreamEvent` values. The renderer must not parse provider SSE directly.
- Parse untrusted responses with field allowlists and bounded traversal. Never display tool results, web-search result payloads, or unknown provider objects as final assistant text.

### Reasoning

- Reasoning enablement is conversation state. Model defaults affect only new conversations and must not overwrite an explicit stored `false`.
- Build reasoning fields in `request-adapters.ts` according to provider and API format. Keep `reasoning.effort` / equivalent values within the shared supported set.
- Anthropic models use configured adaptive thinking or manual extended thinking; disabled requests must use a protocol-valid disabled shape.
- Normalize supported reasoning deltas and usage without inventing hidden reasoning. A nonzero `reasoningTokens` value may exist without visible reasoning text.
- Preserve provider reasoning details needed to replay Agent turns. Changes require protocol tests for every affected API format.

### OpenRouter web search

- Web search is enabled only when `provider.kind === 'openrouter'`.
- Use the `openrouter:web_search` server tool. Supported application modes are `off`, `auto`, and `native`; native mode may fall back and must not be described as a provider guarantee.
- Current request limits are `max_results: 5`, `max_uses: 2`, `max_total_results: 8`, and top-level `max_tool_calls: 2`.
- Parse Chat Completions annotations, Responses annotations, and Anthropic citation deltas. Accept only credential-free HTTP/HTTPS citation URLs.
- Deduplicate identical citations while allowing later events for the same URL to enrich title, content, or ranges.
- If search returns sources but no answer text, preserve the sources and display an explicit empty-response state. Never synthesize an answer in the client.
- When quotas or modes change, update request adapters, both gateway documents, and protocol tests; update README/UI copy only when those values are presented there.

Do not add claims that a model has native web search without explicit capability evidence encoded by the current provider path.

## Agent, MCP, Skills, and runtimes

### Agent and MCP loop

- MCP supports `stdio`, Streamable HTTP, and legacy HTTP+SSE. A remote `http` configuration tries Streamable HTTP first and falls back to legacy HTTP+SSE; `sse` explicitly selects the legacy transport.
- The global MCP setting and per-conversation MCP server allowlist determine which servers may expose tools. An explicit empty conversation list exposes none.
- Automatic BM25 retrieval scores the last user message and injects at most 8 tools with a default minimum score of 0.75. `all` mode exposes all allowed tools. Keep retrieval constants, UI copy, documentation, and tests synchronized.
- Provider-safe aliases must remain stable and collision-safe. Never expose a model tool name that cannot be mapped back to the original server/tool pair.
- Approval policies are `always`, `sensitive`, and `full-access`; legacy `never` migrates to Full Access. Approval timeout is five minutes or no timeout.
- The Agent tool-call loop defaults to 30 rounds and accepts 1 through 100. Reaching the limit must produce a checkpoint rather than silently continuing.
- Preserve `toolExecutions` and `agentTrace` in protocol-neutral form. Only the last interrupted Assistant message on the active branch may be resumed.
- Natural commands such as `continue`, `resume`, or supported Chinese equivalents are resume signals only when that checkpoint exists and no attachment or substantive new requirement replaces the task.

### Skills

- A Skill may contain Markdown instructions, reference documents, and Python/shell reference scripts. Entry Markdown, additional Markdown, and Python/shell source are included in System Instructions as reference material.
- `other` files are preserved for import/export but are not injected. Python and shell files may be shown to the model as reference code, but they are never run automatically.
- Pinning, `$skill-id` mention, automatic retrieval, and model-requested `agentbox_load_skill` are distinct activation paths. Preserve activation-source records shown in the UI.
- `agentbox_load_skill` is read-only, does not run scripts, and does not require approval.
- The code runner may run model-generated code only through its explicit approved tool path. A Skill containing a script is not evidence that the script ran.
- Built-in Skill names, descriptions, and Markdown follow the application language. Preserve user enablement and customized content when refreshing localized built-ins.
- ZIP Skill archives and conversation backups are different formats and security boundaries. Do not mix their parsers or password behavior.

### Working directories, terminal, and developer runtimes

- New conversations require an absolute working directory; legacy directory-less conversations may load but must choose a directory before sending.
- The Vault stores only the path reference. Workspace content is not automatically copied into or encrypted by the Vault.
- Shell auto-detection follows platform-specific candidates. Custom shells support line-separated launch arguments and a `{command}` placeholder.
- Preserve terminal command length, timeout, output, environment-name, and cancellation limits. Do not add broad process environment forwarding that can leak secrets.
- Runtime resolution may inject `PATH`, `JAVA_HOME`, `GOROOT`, `VIRTUAL_ENV`, and `CONDA_PREFIX` into terminal/code environments. Keep validation and tests aligned with the exact current behavior.
- Conda environments are resolved to their interpreter prefix; do not require interactive `conda activate` or wrap every invocation in `conda run`.
- Do not claim that every discovered `python` executable is Python 3 unless the relevant resolver explicitly validates the version.

## Conversation, context, and renderer state

### Conversation tree and persistence

- Persistent types live in `src/shared/types.ts`; renderer-only extensions live in `src/renderer/src/types.ts`.
- Conversation branches use `parentMessageId` and `currentLeafId`. Editing with regeneration or regenerating a response adds a sibling branch; do not silently delete previous branches.
- Save the user message successfully before starting a paid provider request. On failure, stop and restore the draft and attachments.
- Capture the model used by each Assistant response. Persist reasoning, usage, citations, tool executions, Agent trace, and interruptions.
- Usage events may arrive in multiple parts; merge fields rather than replacing the entire usage object.
- Merge citations by normalized URL, preserve later enrichment, and never treat citations as trusted executable content.

### Context management

- `contextManagementMode` defaults to `manual`.
- Manual mode blocks ordinary sends when over budget. `allowContextTrimming` applies only to that request and does not delete local history or change global settings.
- Automatic trimming removes complete user/assistant turns only. Preserve system messages and the latest user turn; if those alone exceed the budget, block the request.
- The configured context window is a client budget and cannot increase a provider's real limit.
- Shared token estimates belong in `src/shared/token-estimate.ts`. Do not create diverging renderer/main estimators.
- Token step controls use 64,000-token increments with power-of-two anchors plus 1M and 2M. Input schema minima and UI step size are separate concepts.

### Conversation titles

- Generate a title only after the first successful user/Assistant turn and never overwrite a manual rename.
- Reuse the existing chat stream path and `runStreamWithReplay`; do not add a title-only IPC channel.
- Title requests force reasoning off, web search off, and `maxOutputTokens: 32`; truncate the first user input to 2,000 characters and stop waiting after 20 seconds.
- Prefer `AppSettings.titleGenerationModelId`; otherwise use the conversation model. Title requests are not persisted as conversation messages.
- Keep cleanup in `src/renderer/src/title.ts`. Failure must silently retain the deterministic fallback title.

### Renderer and content behavior

- Subscribe to stream events before or atomically with request startup so early events cannot be lost.
- External Markdown links use `target="_blank"` and `rel="noopener noreferrer"`; the main process remains the final URL gate.
- Use trimmed content to decide whether a response is empty. If citations exist without body text, show the explicit provider-empty state and no meaningless copy action.
- User nickname and avatar are local display fields only and must never enter model prompts.
- Attachment handling differs by protocol. Preserve image/document/text conversion rules and size limits rather than assuming all formats support identical document blocks.
- Composer keyboard behavior, paste/drag attachment behavior, and IME handling belong in testable helpers when possible.

## Code style and validation

- TypeScript strict mode and `noUncheckedIndexedAccess` are enabled. Do not use `any` to bypass external-data validation.
- Validate and normalize user, network, IPC, Vault, MCP, and archive input before storing or forwarding it.
- Prefer small pure functions, explicit types, and narrow type guards at trust boundaries.
- ESLint owns code-quality checks and Prettier owns formatting. Keep the configured no-semicolon, single-quote, trailing-comma, and 120-column style by running the repository commands instead of hand-tuning conflicting formatting.
- Do not introduce unrelated formatting churn. Generated locale bundles, `pnpm-lock.yaml`, `CLAUDE.md`, and `AGENTS.md` are intentionally excluded from Prettier; preserve their generator-owned or manual formatting.
- Use `apply_patch` for focused edits. Mechanical generation may use the repository scripts.
- `tsconfig.node.json` includes the complete renderer source tree because jsdom integration tests import real component graphs. Keep both `tests/**/*.ts` and `tests/**/*.tsx` in its include set.

Use the test map in [`docs/development-and-testing.md`](./docs/development-and-testing.md) rather than maintaining an incomplete duplicate list here. At minimum, cover:

- the normal path and disabled/off state;
- missing fields from legacy Vaults;
- malformed, oversized, or adversarial external input;
- cancellation, timeout, denial, and failure paths;
- every affected API format;
- both application languages for user-visible product terminology;
- migration and recovery behavior for storage changes.

Security, protocol, storage, proxy, MCP, workspace, backup, and localization changes require focused tests in addition to the full suite.

## Troubleshooting constraints

- If `pnpm dev` compiles but the window exits immediately, check for another AgentBox/Electron process holding the single-instance lock.
- Main must remain CommonJS at `out/main/index.cjs`, matching `package.json#main`. A development build can pass while a packaged ESM main fails to resolve legacy CommonJS dependencies from `app.asar`.
- If `window.agentbox` is missing, verify the CommonJS preload output and path before changing sandbox settings.
- On first-launch storage failures, inspect `safeStorage` and the OS credential backend; never create a plaintext fallback.
- After icon changes, run `node scripts/generate-icons.mjs` and `node scripts/make-ico.mjs`, and commit the required PNG/ICO assets under `build/`. `icon.svg` is a source asset; packaging consumes the generated files referenced by `package.json`.
- When testing real provider APIs, use the existing IPC/main-process path. Never read, print, or copy a stored user key. Use temporary conversations, bounded output, bounded tool calls, and minimal cost.

## Completion checklist

Before handing off a completed change:

1. Confirm security boundaries, protocol behavior, and legacy Vault compatibility still hold.
2. Keep shared types, normalization, IPC, repository behavior, renderer state, and tests synchronized.
3. Add focused tests for new behavior and failure paths.
4. Update both English and Chinese READMEs/documents when behavior or user-facing copy changed; preserve all reciprocal language links.
5. Regenerate and validate i18n resources when visible copy changed; confirm executable assets did not enter locale bundles.
6. Run `pnpm check` and `pnpm build` for code changes.
7. Run `pnpm package` and launch the unpacked app for packaging, preload, entry-point, or runtime-dependency changes.
8. Validate Markdown links, paired filenames, code fences, and trailing whitespace for documentation changes.
9. Confirm no log, fixture, screenshot, error, or generated file contains credentials or sensitive Vault data.

