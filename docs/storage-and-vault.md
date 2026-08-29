# 2. Encrypted Storage and Vault Security

> 中文：[加密存储与 Vault 安全](../docs_zh/storage-and-vault.md)

AgentBox stores settings, provider credentials, models, conversations, skills, and MCP server configurations in a local encrypted Vault managed by the main process. Workspace files are outside the Vault; a conversation stores only the absolute path to its working directory.

---

## 🔐 Envelope encryption model

```text
+-------------------------------------------------------------------+
| Electron safeStorage · OS-backed credential protection            |
+-------------------------------------------------------------------+
                               |
               encryptString(base64-encoded 256-bit key)
                               v
+-------------------------------------------------------------------+
| <userData>/vault/master-key.bin                                   |
| safeStorage-wrapped random Vault key                              |
+-------------------------------------------------------------------+
                               |
            AES-256-GCM · random 12-byte IV · 16-byte tag
            AAD: "agentbox:vault:v1"
                               v
+-------------------------------------------------------------------+
| <userData>/vault/user-data.v1.enc                                 |
| One encrypted JSON envelope containing the complete Vault state   |
+-------------------------------------------------------------------+
```

Provider API keys, MCP environment variables and headers, and proxy credentials are fields inside the Vault JSON and are protected by encryption of the complete Vault. They are not each wrapped in another independent ciphertext. When the renderer reads providers, MCP servers, or settings, it receives a redacted view.

### 1. Vault-key generation and wrapping

- On first initialization, [`EncryptedStore`](../src/electron/storage/encrypted-store.ts) generates a random 32-byte key, encodes it as Base64, and passes it to Electron's `safeStorage.encryptString()`. The wrapped result is written to `master-key.bin`.
- If `safeStorage.isEncryptionAvailable()` is false, the application refuses to load user data. On Linux, it also rejects the unencrypted `basic_text` backend rather than falling back to plaintext.
- On application shutdown, the in-process key Buffer is overwritten and released. The key and decrypted state must still reside in the trusted main-process memory while the application is running.
- Startup supports legacy ChatBox Lite user-data directories and the legacy AAD. Directory migration either copies or re-persists the old data; after a legacy-AAD envelope is read, the next Vault write uses the current `agentbox:vault:v1` AAD.

### 2. Vault encryption and write semantics

- Every persistence operation serializes the complete state and produces a version-1 JSON envelope using a new random 12-byte IV, AES-256-GCM, and a 16-byte authentication tag.
- Mutations are serialized through a Promise queue. The store clones the state, applies the mutation, validates the resulting schema, and replaces its in-memory state only after persistence succeeds.
- Data is first written to a unique `.tmp` file in the same directory with `flag: 'wx'` and mode `0600`, then renamed to the Vault path. The temporary file is removed after failure.
- The current implementation does **not call `fsync`**. A temporary file plus rename prevents a partial JSON write from directly becoming the active file, but it is not a durability barrier against sudden operating-system or hardware power loss.

### 3. Workspace boundary and Agent recovery

- The Vault persists only the normalized absolute `Conversation.workingDirectory` path. Source code, dependencies, Git data, and other project files are not imported or encrypted by [`EncryptedStore`](../src/electron/storage/encrypted-store.ts).
- This does not make all Agent tools read-only. When Agent mode is enabled and the applicable tool is approved, workspace writes or terminal commands may operate within that directory. Those actions are separate from Vault persistence.
- A deep backup is the only storage-related operation that recursively reads an entire working directory. It reads the source directory and writes it to a user-selected ZIP; it does not import the project into the Vault.
- Assistant messages can persist structured `interruption` metadata, `agentTrace`, and tool results. Recovery uses these persisted checkpoints rather than transient renderer error state.
- LangGraph runtime checkpoints use separately encrypted records under `<userData>/vault/agent-checkpoints-v1/`. Their AES-GCM and filename-HMAC keys are derived from the in-memory Vault master key; logical IDs and payloads are never used as filenames or written in plaintext.

The record format, saver contract, quotas, and lifecycle are documented in [Encrypted LangGraph Checkpoints](./langgraph-checkpoints.md).

---

## 📦 Vault schema

The domain structure is defined in [`src/electron/storage/app-repository.ts`](../src/electron/storage/app-repository.ts), with shared entities in [`src/shared/types.ts`](../src/shared/types.ts):

```typescript
interface VaultState {
  schemaVersion: 1
  settings: AppSettings
  providers: StoredProvider[]
  models: ModelConfig[]
  conversations: Conversation[]
  skills?: Skill[]
  mcpServers?: McpServerConfig[]
  browserProfiles?: BrowserCookieProfile[]
}
```

`skills`, `mcpServers`, and encrypted `browserProfiles` remain optional in the interface for compatibility with older Vaults. Loading/validation gives a missing `skills` field the localized built-in Skill set, while missing `mcpServers` and `browserProfiles` become empty arrays; profiles whose conversation no longer exists are discarded. [`settings-schema.ts`](../src/electron/storage/settings-schema.ts) similarly migrates missing newer settings to safe defaults.

The LangGraph checkpoint sidecar is deliberately not a `VaultState` field. Superstep writes therefore do not rewrite the complete conversation Vault. It is machine-local execution state; `agentTrace` remains in the conversation schema and portable backups.

`AppSettings.userNickname` and `userAvatar` are display-only local profile fields and are never included in model prompts. A nickname is limited to 50 characters. An avatar must be a PNG, JPEG, or WebP Base64 data URL no longer than 3,000,000 characters, and the renderer crop flow limits each dimension to 1,000 pixels. When a legacy Vault has no `language`, validation uses the system-language fallback supplied at startup.

Assistant `usage` retains aggregate token counters plus an optional `modelRequests` breakdown keyed by one-based Agent model turn. Each breakdown contains only bounded non-negative integer counters and at most 101 requests (100 tool turns plus the terminal model request). Loading recomputes aggregate totals from a valid breakdown, while legacy messages containing only aggregate usage remain readable unchanged.

Agent token optimizations are persisted as independent `AppSettings` preferences and all default to disabled for new and legacy Vaults. Their retained parameter defaults remain available while a feature is off: tool-result compaction uses `agentToolResultMaxCharacters: 16000` (2,000–100,000), dynamic tool exposure uses `agentDynamicToolLimit: 4` (1–16), lazy Skill resource loading uses `agentLazySkillResourcesEnabled: false`, and in-run context compaction uses a 70% threshold (50%–95%) while keeping 3 recent turns (1–10). `agentProviderContextOptimizationMode` accepts `off`, `auto`, `prefix-cache`, or `native-continuation` and defaults to `off`. Settings normalization rejects unknown modes, non-boolean switches, and non-integer or out-of-range parameters instead of silently coercing them.

When native continuation is active, an Assistant message may store a validated `providerContinuation` containing an OpenAI Responses handle and one-based model turn. The handle is bounded to 200 safe identifier characters, belongs only to Assistant messages, remains inside the encrypted Vault, and is included in conversation backups as part of the message JSON. It is an opaque provider-side state reference rather than an API credential; deleting local conversation data removes the local reference but does not override the provider’s own retention policy.

`builtInBrowserEnabled`, persistent cookies, Agent screenshots, file uploads, downloads, and loopback HTTP are independent conservative application opt-ins and default to `false` for older Vaults. `browserHomePage` defaults to `https://www.google.com/` when missing; normalization accepts credential-free HTTPS URLs, plus loopback HTTP only while loopback access is enabled. `Conversation.browserToolEnabled` is also optional and defaults to disabled. Live browser sessions always use partitions without `persist:`. When Cookie persistence is enabled, the main process snapshots accepted cookies into optional `browserProfiles`, keyed by conversation ID and encrypted as part of the Vault; a one-second debounce follows Chromium Cookie changes and session close/eviction makes a final best-effort snapshot attempt. Restored cookies are shared by the new session's tabs. No Cookie profile or Cookie value is returned through IPC. Cache, local storage, navigation history, DOM state, approved origins, and element references remain memory only. Sanitized browser calls, semantic text, and approved screenshot images are ordinary `toolExecutions`/`agentTrace` data and remain encrypted with the conversation.

Changing the overall browser or Cookie-persistence setting closes all live browser sessions. Turning Cookie persistence off then deletes all stored `browserProfiles`; disabling only the overall browser feature retains encrypted Cookie profiles while the persistence preference remains enabled.

---

## 📏 Resource quotas and validation

The main limits are enforced by [`app-repository.ts`](../src/electron/storage/app-repository.ts), [`vault-resource-limits.ts`](../src/electron/storage/vault-resource-limits.ts), and [`web-metadata-schema.ts`](../src/electron/storage/web-metadata-schema.ts):

| Resource                                                        |             Current limit |
| --------------------------------------------------------------- | ------------------------: |
| Providers                                                       |                       100 |
| Models                                                          |                     2,000 |
| Conversations                                                   |                    10,000 |
| Skills                                                          |                       500 |
| MCP servers                                                     |                       100 |
| Messages per conversation                                       |                    20,000 |
| Message content or reasoning field                              | 2,000,000 characters each |
| Counted content per conversation                                |     50,000,000 characters |
| Serialized data across all conversations                        |                    50 MiB |
| Messages / citations across all conversations                   |              100,000 each |
| Citations per message                                           |                       100 |
| Attachments per message                                         |                        20 |
| Files per skill / content per skill file                        |   50 / 500,000 characters |
| Arguments / environment variables per MCP server                |                  50 / 100 |
| Each MCP argument or environment-variable value                 |          8,192 characters |
| Cookies per browser profile                                     |                     2,000 |
| Browser Cookie profiles                                         |                    10,000 |
| Serialized browser Cookie profile data                          |     10,000,000 characters |
| Encrypted checkpoint threads / checkpoints per thread           |                 256 / 512 |
| Checkpoint data per thread / valid manifest-accounted namespace |          64 MiB / 256 MiB |

Saving a conversation applies both per-conversation and aggregate quotas. To avoid locking users out of legacy data when a newer aggregate quota is introduced, an already-over-limit Vault can still load and the user can delete or shrink data. A save that would further increase any over-limit dimension is rejected.

---

## 🧹 Clearing conversation data

**Settings → Data and security → Clear all conversation data** performs these steps:

1. `ChatGateway.cancelAll()` aborts every active request and resolves pending tool approvals as denied.
2. The encrypted checkpoint namespace is cleared. A failure stops the operation rather than reporting that conversation data was cleared.
3. The repository replaces `conversations` with an empty array. Settings, providers and API keys, models, skills, and MCP server configurations remain unchanged.
4. The complete Vault is encrypted again with a new random IV and written to disk. The `safeStorage`-wrapped Vault key is retained rather than rotated.

This operation removes conversations from the active Vault. It is not a forensic secure-erasure guarantee for the underlying storage medium.

The operation also closes every in-memory browser session and removes every encrypted browser Cookie profile before deleting conversations. Removing one conversation closes its tabs and removes only its Cookie profile. Hiding the browser panel does not clear temporary state; closing the session, deleting the conversation, closing the window, or quitting the application does. Session close and shutdown make a best-effort final Cookie-snapshot attempt when persistence is enabled. The direct `before-quit` path waits for its cleanup attempt before destroying the Vault key, but snapshot failures do not block shutdown.

---

## 📦 Conversation ZIP backups

**Settings → Data and security → Export backup** invokes [`src/electron/backup/backup-export.ts`](../src/electron/backup/backup-export.ts). The renderer submits only the mode and optional one-time password; the system save dialog, Vault snapshot access, and file creation all run in the main process.

### Backup modes

- **Shallow:** Exports every conversation. Each conversation has both a complete JSON representation and readable Markdown. JSON preserves every branch in the conversation tree, attachments, citations, usage, skill activations, tool executions, Agent trace, and interruption metadata.
- Browser text and screenshot tool results already stored in messages are included. Encrypted browser Cookie profiles and live cookies, cache, storage, DOM state, origin grants, tab state, and navigation history are excluded.
- **Deep:** Adds every working directory referenced by a conversation. The implementation deduplicates identical directories by `realpath`, preserves empty directories and symbolic links without following nested links, and skips other special files while recording their paths in manifest warnings. It rejects a workspace located within the current AgentBox user-data root and skips that root when it is nested beneath an otherwise valid workspace, so the active Vault, wrapped key, browser profiles, and checkpoint sidecar cannot enter a deep backup through workspace traversal.

### Encryption and privacy boundary

- The password is optional and limited to 256 characters. With a non-empty password, `@zip.js/zip.js` encrypts ZIP entries using WinZip AES-256 (AE-2). The password is not written to settings or the Vault, and AgentBox cannot recover it.
- JSON, Markdown, and workspace files enter the archive as their original content. They are directly readable without a password; with a password, at-rest protection comes from ZIP entry encryption.
- The ZIP central directory does not encrypt entry names. Conversation files use sequence numbers rather than titles, while relative workspace filenames remain visible in a deep backup. `manifest.json` also records absolute working-directory mappings, but its contents are encrypted when a password is set.
- The structured conversation export excludes provider API keys, authentication credentials, the Vault key and Vault files, the machine-local LangGraph checkpoint sidecar, and provider, model, MCP server, Skill, and application settings. The current AgentBox user-data root is also excluded during deep workspace traversal. `agentTrace` remains in conversation JSON so recovery is portable. Conversation text and workspace files may still contain sensitive information, including user-created copies of otherwise excluded data.

### Writing and replacement

The archive is first written to a randomly named `.partial` file in the target directory with mode `0600`. The selected destination is replaced only after the ZIP writer closes successfully and the output stream finishes. If the destination already exists, it is temporarily displaced; on replacement failure AgentBox attempts to restore it. Incomplete `.partial` files and displaced files are cleaned up on a best-effort basis, so filesystem or permission failures can still leave them behind. A deep backup excludes the selected destination path; workspace scanning finishes before the `.partial` file is created, so the archive cannot recursively include itself.

ZIP root layout:

```text
manifest.json                         # Format, mode, version, counts, and workspace mapping
README.txt                            # User-facing contents and security notes
conversations/index.json             # Conversation index
conversations/conversation-0001.json # Complete conversation data
conversations/conversation-0001.md   # Readable conversation transcript
workspaces/workspace-0001/            # Deep backups only
```

The current manifest uses `format: "agentbox-backup"` and `formatVersion: 1`. Its `encryption.method` explicitly records either `none` or `WinZip AES-256 (AE-2)`.
