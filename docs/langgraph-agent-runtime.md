# LangGraph Agent Runtime

> 中文：[LangGraph Agent Runtime](../docs_zh/langgraph-agent-runtime.md)

AgentBox uses a request-scoped LangGraph `StateGraph` to control the multi-turn Agent lifecycle. The runtime is an orchestration component inside the Electron main process; it does not replace AgentBox's provider adapters, MCP client, tool security policy, encrypted repository, or renderer event model.

## Responsibilities

The runtime owns only state transitions:

```text
START -> model -> tools -> model -> ... -> terminal -> END
                   |                     |
                   +-- tool limit -------+
```

`ChatGateway` remains the request and security facade. It supplies callbacks that perform provider requests, consume SSE, validate and approve tools, execute built-in or MCP tools, trim context, and emit the existing `StreamEvent` values.

| Component                 | Responsibility                                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `ChatGateway`             | Request validation, provider/model resolution, proxy dispatch, network watchdog, error redaction, approval waiters, and callback composition |
| `runAgentRuntime()`       | Model/tool/terminal routing, turn accounting, recursion bounds, cancellation propagation, and optional checkpoint resume                     |
| Request/protocol adapters | OpenAI Chat Completions API, OpenAI Responses API, and Anthropic Messages API wire formats                                                   |
| Tool executors            | AJV validation, approval policy, workspace restrictions, MCP routing, code/terminal execution, and result limits                             |
| Renderer stream hook      | Projection of normalized events into assistant text, reasoning, citations, tools, `agentTrace`, and interruption metadata                    |

## Runtime state

The graph uses provider-neutral AgentBox messages rather than LangChain message classes.

| State field      | Meaning                                                                               |
| ---------------- | ------------------------------------------------------------------------------------- |
| `messages`       | Context prepared for the next provider request                                        |
| `turn`           | Number of model-node entries in the current run                                       |
| `toolTurns`      | Number of model responses whose requested tools were accepted for handling            |
| `modelResult`    | Normalized result of the latest provider stream, including tool calls and replay data |
| `terminal`       | Whether a terminal callback completed                                                 |
| `terminalReason` | `complete`, `unexpected_tool_call`, or `tool_turn_limit`                              |

A provider response containing several tool calls consumes one tool turn. Calls are processed in provider order so approval order and side-effect behavior remain stable.

## Transition rules

After each model node, the graph selects one route:

- no tool calls: run the normal completion handler;
- tool calls outside Agent mode: terminate with `unexpected_tool_call` without executing them;
- tool calls after the configured limit: emit an error result for every unexecuted call and terminate with `tool_turn_limit`;
- valid Agent tool turn: execute the tool callback, append its assistant/tool history, and return to the model node.

The graph recursion limit is derived from the configured tool-turn limit. The current product limit is 1–100 turns, with a default of 30.

## Streaming and cancellation

Provider streaming stays in `ChatGateway`. Text, reasoning, citations, usage, provider items, and tool-argument deltas are emitted while a model node is running; LangGraph checkpoints only at graph boundaries.

One request-scoped `AbortSignal` is passed to the graph and all callbacks. It cancels provider fetches, MCP calls, code execution, terminal commands, workspace operations, and approval waits. The 120-second network-stall timer is active only while provider data is expected and is paused during tool handling.

## Checkpoint behavior

Agent requests created by the renderer include `responseMessageId`. The Gateway derives an encrypted checkpoint thread from the conversation and response IDs and passes the AgentBox `BaseCheckpointSaver` adapter to the graph.

Direct graph resume is limited to failures at a provider node:

| Interruption                                    | Resume path                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------- |
| Rate limit, network failure, timeout, API error | Resume the existing graph thread when its descriptor and context digest match   |
| Missing or stale thread                         | Rebuild provider history from validated `agentTrace` and create a new thread    |
| User cancellation                               | `agentTrace` fallback; the interruption may have occurred inside a side effect  |
| Output or tool-turn limit                       | `agentTrace` fallback and a new run                                             |
| Unknown tool or execution failure               | `agentTrace` fallback; never re-enter an operation with unknown external status |

Successful completion deletes the checkpoint thread. Interrupted threads remain available until resumed, deleted with their message/conversation, or evicted as a whole under checkpoint quotas.

See [Encrypted LangGraph Checkpoints](./langgraph-checkpoints.md) for storage, quota, and deletion details.

## Security boundaries

- Provider credentials and proxy configuration never enter graph state.
- LangGraph tools cannot bypass AgentBox argument validation, exposed-tool aliases, approval policy, path checks, timeouts, or result limits.
- The runtime explicitly disables LangSmith/LangChain tracing in the desktop main process and runs inside a no-callback async-local context.
- Checkpoints are encrypted local execution state; `agentTrace` remains the portable protocol ledger and backup representation.
- The renderer receives only normalized `StreamEvent` values and never reads checkpoint files or provider protocol responses directly.

## Implementation map

- [`src/electron/api/agent-runtime.ts`](../src/electron/api/agent-runtime.ts): graph state and transition routing
- [`src/electron/api/gateway.ts`](../src/electron/api/gateway.ts): request-scoped callbacks, checkpoint selection, and event emission
- [`src/electron/storage/agentbox-checkpoint-saver.ts`](../src/electron/storage/agentbox-checkpoint-saver.ts): LangGraph saver adapter
- [`src/renderer/src/hooks/useChatStream.ts`](../src/renderer/src/hooks/useChatStream.ts): event projection and `agentTrace` construction
- [`src/renderer/src/agent-continuation.ts`](../src/renderer/src/agent-continuation.ts): interruption classification and natural resume commands

## Test coverage

- `tests/langgraph-agent-runtime.test.ts`: transition routing, limits, failures, cancellation, and tracing isolation
- `tests/gateway-mcp-loop.test.ts`: provider/tool loops, durable provider failure resume, stale checkpoint fallback, approvals, Skills, and built-in tools
- `tests/agent-runtime.test.ts`: provider trace replay and tool security contracts
- `tests/agent-continuation.test.ts`: interruption classification and resume-command rules
