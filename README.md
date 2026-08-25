# AgentBox

**English** | [简体中文](./README_zh.md)

> **A private, powerful desktop client for multi-model AI agents**
>
> Built with React 19, TypeScript 5.7, and Electron 35, with native adapters for the OpenAI Chat Completions API, OpenAI Responses API, and Anthropic Messages API, plus Agent Skills and Model Context Protocol (MCP) servers.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61dafb.svg)](https://react.dev/)
[![Electron](https://img.shields.io/badge/Electron-35-47848F.svg)](https://www.electronjs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

## Highlights

- **Local-first encrypted storage:** the renderer is sandboxed, and stored API keys are never returned to it in plaintext. A random data key is protected by OS secure storage, and the local vault is encrypted with AES-256-GCM.
- **Portable conversation backups:** export lossless JSON and human-readable Markdown. Shallow backups contain conversations; deep backups also include unique conversation working directories. Optional password protection uses WinZip AES-256 (AE-2).
- **Providers and API formats are independent:** configure providers, models, and wire protocols separately. AgentBox supports the OpenAI Chat Completions API, OpenAI Responses API, and Anthropic Messages API, with presets for [OpenRouter](https://openrouter.ai/) and local [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) connections.
- **MCP server integration:** connect local `stdio` servers or remote Streamable HTTP servers, with fallback support for legacy HTTP+SSE. BM25 tool retrieval, per-conversation server selection, approval policies, and Tool Explorer keep large tool catalogs manageable.
- **Resumable Agent execution:** Agent mode can run up to 30 tool-call turns by default, configurable from 1 to 100. Rate limits, network failures, output limits, and manual cancellation preserve a resumable checkpoint.
- **Integrated terminal and workspace tools:** use an automatically detected cross-platform shell or configure a custom executable and arguments. Native workspace tools read UTF-8 files in chunks and create, overwrite, or append files without shell escaping.
- **Conversation-scoped development environments:** every conversation has a working directory. Configure JDK, Go, PHP, and Python runtimes; Python supports project `.venv`/`venv`, system interpreters, virtual environments, Conda environments, and custom interpreters.
- **Multi-file Agent Skills:** Skills can include Markdown instructions, reference documents, and non-automatic Python or shell reference scripts. Pin Skills to a conversation, invoke `$skill-id`, use automatic retrieval, or let the model load a relevant Skill on demand. ZIP skill archives can be imported and exported.
- **Rich chat interface:** Markdown, GFM, syntax-highlighted code, KaTeX math, multimodal attachments, image optimization and preview, editable conversation trees, regenerated branches, and version navigation.
- **Reasoning and web search:** normalize reasoning output and usage across supported providers. OpenRouter web search uses the `openrouter:web_search` server tool with automatic or provider-native search modes and structured citations.
- **English and Simplified Chinese UI:** language resources are shared by the renderer and Electron main process. On first launch, Chinese system locales default to Simplified Chinese; all other locales default to English. The selection is persisted in encrypted settings.

## Technical documentation

The English documentation is in [`docs/`](./docs/README.md). The corresponding Chinese documentation is in [`docs_zh/`](./docs_zh/README.md).

- [System architecture and process isolation](./docs/architecture.md)
- [Encrypted storage and vault security](./docs/storage-and-vault.md)
- [API protocols and request gateway](./docs/gateway-and-protocols.md)
- [Agent Skills system](./docs/skills-system.md)
- [MCP servers and tool retrieval](./docs/mcp-integration.md)
- [UI and interaction model](./docs/ui-and-components.md)
- [Development, testing, and releases](./docs/development-and-testing.md)
- [Working directories and developer runtimes](./docs/workspaces-and-runtimes.md)
- [Internationalization](./docs/i18n.md)

## Quick start

### Requirements

- Node.js 20 or later
- pnpm 9 or later
- An OS credential backend: Windows credential protection, macOS Keychain, or Linux Secret Service

### Install and run

```powershell
git clone https://github.com/ac-1e9plus7/agent-box.git
cd agent-box
pnpm install

# Start Electron with the Vite development server
pnpm dev

# Validate the project
pnpm check

# Build production bundles
pnpm build
```

Additional packaging commands:

```powershell
# Build an unpacked application directory
pnpm package

# Build distributable artifacts for the current platform
pnpm dist
```

Electron Builder produces an NSIS installer and portable executable on Windows, a DMG on macOS, and an AppImage on Linux. The release workflow builds Windows x64/arm64, macOS native, and Linux x64/arm64 artifacts.

## Security invariants

1. **The renderer cannot read stored API keys.** It may submit a newly entered key, but persisted keys are write-only and are represented only by `hasApiKey` or masked fields; network requests and authentication stay in the main process.
2. **There is no plaintext credential fallback.** If OS secure storage is unavailable, AgentBox refuses to load or persist protected local data.
3. **OpenRouter routing is privacy-oriented by default.** New model configurations default to `data_collection: "deny"` and `zdr: true`.
4. **Workspace operations are scoped.** File and terminal tools operate relative to the conversation working directory, reject traversal, and protect sensitive actions with approval policies.

## License

AgentBox is available under the [MIT License](./LICENSE).
