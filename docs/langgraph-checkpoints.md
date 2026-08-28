# Encrypted LangGraph Checkpoints

> 中文：[LangGraph 加密 Checkpoint](../docs_zh/langgraph-checkpoints.md)

AgentBox implements `BaseCheckpointSaver<number>` on top of an encrypted record sidecar inside the Vault directory. The sidecar stores machine-local LangGraph execution state without adding high-frequency checkpoint fields to the main `VaultState` JSON document.

## Storage architecture

The primary Vault remains one AES-256-GCM encrypted document. Checkpoints use a separate record namespace because LangGraph can write a checkpoint and pending writes several times per superstep; putting those records in `VaultState` would rewrite the complete conversation Vault on every graph boundary.

```text
Electron safeStorage
        |
OS-wrapped Vault master key
        |
        +-- existing AES-256-GCM Vault document
        +-- HKDF checkpoint data key -> encrypted record payloads
        +-- HKDF checkpoint name key -> HMAC scope and record names
```

Physical layout:

```text
<userData>/vault/agent-checkpoints-v1/
  scope-<hmac(thread_id)>/
    record-<hmac(logical_record_key)>.enc
```

The logical record set for a thread contains an encrypted manifest, checkpoint/metadata records, pending-write records, one base message snapshot, and message delta or fallback snapshot artifacts. Logical conversation, message, checkpoint, task, and channel IDs do not appear in filenames.

## Record encryption

`EncryptedRecordNamespace` derives separate 256-bit data and filename keys using HKDF-SHA-256. Each record uses:

- AES-256-GCM;
- a fresh random 12-byte IV;
- a 16-byte authentication tag;
- record-specific AAD containing the storage format, namespace, HMAC scope, and HMAC record handle;
- a binary `ABRN` envelope with format version 1;
- ciphertext-only temporary files, mode `0600`, and atomic rename.

The record layer rejects files larger than 32 MiB before reading them, detects authentication failure, and zeroes derived keys when the owning `EncryptedStore` is destroyed. There is no plaintext fallback when Electron `safeStorage` is unavailable.

## Layering

### Encrypted record namespace

[`encrypted-record-namespace.ts`](../src/electron/storage/encrypted-record-namespace.ts) owns cryptography, HMAC handles, bounded file access, atomic writes, scope deletion, temporary-file cleanup, and encrypted corruption quarantine.

### Checkpoint repository

[`checkpoint-repository.ts`](../src/electron/storage/checkpoint-repository.ts) owns manifests, quota accounting, pending-write indexing, snapshots/artifacts, lifecycle metadata, whole-thread eviction, and conversation-aware deletion. Repository mutations are serialized through a promise queue; the application single-instance lock provides cross-process writer exclusion.

### LangGraph saver adapter

[`agentbox-checkpoint-saver.ts`](../src/electron/storage/agentbox-checkpoint-saver.ts) owns LangGraph configuration and serializer behavior.

| Method                                           | Behavior                                                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `getTuple(config)`                               | Returns an exact or latest checkpoint, metadata, parent config, and pending writes; missing `thread_id` returns `undefined`                |
| `list(config, options)`                          | Supports thread/namespace/checkpoint selection, `before`, exact metadata filters, descending IDs, and limits                               |
| `put(config, checkpoint, metadata, newVersions)` | Validates checkpoint v4, serializes through `this.serde`, stores the parent relation, and returns the new checkpoint config                |
| `putWrites(config, writes, taskId)`              | Uses `(taskId, WRITES_IDX_MAP[channel] ?? inputIndex)`; ordinary indexes are first-write-wins and special negative indexes may be replaced |
| `deleteThread(threadId)`                         | Idempotently removes the thread manifest, checkpoints, writes, snapshot, and artifacts                                                     |

The inherited parent-chain `getDeltaChannelHistory()` remains available. AgentBox does not implement a custom path for LangGraph's beta delta-channel storage format.

## Message snapshot and delta artifacts

Ordinary LangGraph last-value checkpoints repeat full channel values. Repeating `Message[]` at every Agent turn would make storage grow approximately quadratically.

Before serialization, the saver replaces both `channel_values.messages` and initial/pending `messages` writes with an authenticated AgentBox reference:

1. The first message array is stored as the thread snapshot.
2. Later arrays are compared with the parent materialization.
3. When the next array can be represented exactly as removed IDs plus changed/appended messages, a delta artifact is stored.
4. If exact delta replay is not possible, a bounded snapshot artifact is stored instead.
5. `getTuple()` recursively authenticates and materializes the chain before returning it to LangGraph.

The reference chain is limited to 512 records. Provider message IDs and the exact order are checked by replay; a lossy delta is never accepted.

## Thread identity and descriptors

The renderer creates `responseMessageId` before starting an Agent response. The Gateway derives a fixed-length thread ID from the conversation and response IDs; `EncryptedRecordNamespace` then turns that logical ID into an HMAC directory name.

The encrypted manifest descriptor contains:

- conversation and response message IDs;
- runtime version;
- SHA-256 digest of the sanitized base context, model ID, and API format;
- lifecycle: `active`, `interrupted`, `completed`, or `abandoned`;
- whether a persisted `agentTrace` fallback is available;
- creation, update, and access timestamps.

On startup, a process-local `active` thread becomes `interrupted` when it has a trace fallback, otherwise `abandoned`. This prevents a crashed process from leaving permanently protected active entries.

## Resume and `agentTrace`

`agentTrace` remains stored in assistant messages and exported in conversation backups. It is the protocol-neutral replay ledger for Responses reasoning items, Anthropic thinking signatures, tool calls, and tool results.

The Gateway resumes an existing graph thread only when:

- the conversation and interrupted response IDs match;
- the context digest matches the current base branch;
- the interruption was a rate limit, network failure, timeout, or API error.

Missing or stale checkpoints create a new thread from the existing validated provider-history/`agentTrace` path. Cancellation, output limits, tool limits, and uncertain side-effect states also use this path, preventing a tool node from being blindly replayed.

Checkpoint corruption and I/O failures are surfaced as checkpoint errors; they are not silently treated as a valid trace fallback.

## Quotas

Checkpoint quotas are independent from conversation quotas.

| Dimension                           |   Limit |
| ----------------------------------- | ------: |
| Threads                             |     256 |
| Namespaces per thread               |       8 |
| Checkpoints per thread              |     512 |
| Pending writes per checkpoint       |   1,024 |
| Serialized checkpoint value         |   2 MiB |
| Serialized metadata                 | 256 KiB |
| One pending-write value             |   1 MiB |
| Pending-write values per checkpoint |   8 MiB |
| Base message snapshot               |  24 MiB |
| One message artifact                |   4 MiB |
| One thread                          |  64 MiB |
| Complete checkpoint namespace       | 256 MiB |
| Manifest                            |   2 MiB |
| One encrypted record file           |  32 MiB |

Projected encrypted record sizes, including envelope overhead and serialized wrappers, are counted before the manifest is committed. An already-over-limit thread remains readable and deletable but cannot grow.

## Eviction and deletion

Quota recovery removes whole inactive threads only. Ancestor checkpoints and pending writes are never pruned independently.

Eviction order:

1. abandoned threads, oldest access first;
2. completed threads left by cleanup failure;
3. interrupted threads with a validated `agentTrace` fallback.

Active threads and interrupted threads without a trace fallback are protected. If whole-thread eviction cannot satisfy a mutation, the repository throws `CheckpointQuotaError`.

Lifecycle deletion:

- successful Agent completion deletes its thread;
- provider interruptions retain the thread;
- successful resume deletes the reused thread;
- deleting a message branch deletes checkpoint threads for removed assistant IDs before saving the destructive conversation mutation;
- deleting a conversation removes all descriptors linked to it;
- clearing all conversations clears the checkpoint namespace before the main Vault conversation array;
- Vault reset includes the sidecar because it resides below the same Vault directory.

Conversation ZIP backups exclude checkpoint sidecar files. Portable recovery remains available through `agentTrace`.

## Startup and failure recovery

Repository initialization:

- removes ciphertext temporary files left by interrupted atomic writes;
- authenticates each manifest without eagerly loading every checkpoint;
- quarantines corrupt or missing manifests under an encrypted `corrupt-*` directory name;
- removes encrypted record files not referenced by a valid manifest;
- reclassifies process-local active lifecycles.

Typed repository errors distinguish invalid input, missing records, quotas, corruption, and I/O failures. UI-facing errors expose only a localized category, never decrypted record data or logical IDs.

## Privacy and observability

- Logs never contain logical thread IDs, message content, tool arguments, checkpoint bytes, or decrypted manifests.
- LangSmith/LangChain tracing is forcibly disabled in the Electron main process before graph invocation, even if ambient tracing environment variables are set.
- The renderer has no checkpoint filesystem or repository API.
- Provider keys, proxy credentials, MCP headers, and process environments are not placed in graph state.

## Test coverage

- `tests/encrypted-record-namespace.test.ts`: ciphertext, HMAC names, tamper detection, deletion, and destroyed-key behavior
- `tests/agentbox-checkpoint-saver.test.ts`: `MemorySaver` parity, lists, parents, writes, quotas, message artifacts, corruption quarantine, and startup recovery
- `tests/checkpoint-lifecycle.test.ts`: branch, conversation, and clear-all deletion
- `tests/gateway-mcp-loop.test.ts`: durable provider failure resume and stale digest fallback
- `tests/langgraph-agent-runtime.test.ts`: graph behavior and ambient tracing isolation
