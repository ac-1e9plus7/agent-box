# data-plat Integration

> [中文文档](../docs_zh/data-plat-integration.md)

An HTTP MCP server can opt into data-plat governed authentication. The companion agentbox-data-skills project supplies eight importable skills; importing instructions does not grant execution rights.

## Configuration

Choose Remote HTTP, enter the MCP endpoint, and enable data-plat governed authentication. Provide the core API base URL (without /api/agent/v1), Agent ID, and a current platform user login JWT. Local defaults are http://localhost:8080 and http://localhost:8081/mcp. Remote endpoints require HTTPS; the API URL rejects userinfo, queries, and fragments.

McpServerConfig.dataPlat contains apiBaseUrl, agentId, and loginToken. The Vault encrypts the login token; renderer views return a mask. Saving the mask preserves the secret; explicit null removes the adapter. Users replace expired login JWTs after logging into the platform. Short-lived OBO tokens are issued per operation and never saved into shared server headers.

This version supports the built-in HMAC OBO issuer. Enterprise JWKS issuers require a dedicated integration. Control requests use the configured proxy, reject redirects, and have a 15-second / 256-KiB budget; MCP calls retain cancellation and a 60-second budget. Unsaved connection tests enforce the same URL boundary.

## Exact execution

Each Gateway request owns a DataPlatSession with actual query_plan/report_plan results. query_run, report_run, and query_cancel require exact platform confirmation even under Full Access. The approval card includes serverPlan with normalizedQuery, asset names, source, checks, budgets, expiry, and effective parameters.

An approval capability lives only in the main process and is single-use, bound to the server, tool, arguments, and a credential-inclusive configuration fingerprint. After approval, the host issues confirmations, obtains an approval-bound OBO token, and checks the returned effective arguments. Expired plans and changed configuration fail closed. Each operation uses a separate MCP client; approval tokens never mutate global headers.

Tokens and confirmation secrets never enter model input or events. Control failures return bounded generic messages. The platform still enforces scopes, current domain permissions, plan/run invariants, and AI processing policies. No arbitrary SQL, governance writes, or general authenticated HTTP tool is introduced.

## Journal and cancellation

Vault.dataPlatOperations contains at most 1,000 compact references, without rows, credentials, SQL, or filter values. Confirmation is journaled atomically before dispatch; persistence failure prevents dispatch. Repeating a run for the same conversation/server identity/tool/planId reads the original execution status instead of creating another operation, regardless of pageSize or model call ID changes.

New writes collect references older than 24 hours. Deleting conversations or clearing history clears their journal. This is a recovery index, not the platform audit ledger. A crash between journaling and dispatch can leave an allocated but unexecuted reference; the host does not automatically resend it. A new execution needs an explicit new plan and confirmation. Repeated cancellation reads existing status. accepted/CANCEL_REQUESTED is not CANCELLED, and stopping generation is not JDBC cancellation.

## History and recovery

Governed requests do not restore old graph checkpoints or provider native continuation. New requests keep user inputs, remove all previous assistant-derived text, reasoning, attachments, tool results, and summaries, then reauthorize up to five recent journal references, deduplicated by execution ID. Failures retain only executionId/unavailable and never refill from cached rows.

A data-plat-context event marks derived replies with governedData, preserved through Vault/backup roundtrips and ordinary updates. Removing or disabling the server, or retaining only summaries without calls, does not remove this conservative history treatment. Platform tool names provide legacy detection. This changes future provider input, not already displayed local history, and cannot retract previously transmitted data.

User-copied data in new user inputs cannot be traced automatically. Mixed conversations lose previous assistant context under this first-version policy. Recovery uses current query_status and AI policy results; expiry, redaction, and denial are distinct from empty rows.

## Schemas, skills, and tests

Validation dispatches by $schema: Ajv2020 for 2020-12, the existing Ajv for absent/draft-07 declarations, rejection for unknown dialects. Compilation uses an independent schema copy to avoid stale internal identity caches. Other ordinary MCP behavior is retained.

Skill JSON supports stable ID updates; ZIP does not preserve the project ID. The planning bundle uses a report entry that never executes; the full bundle includes querying and recovery. Platform execution switches, permissions, and AI policies still need configuration.

Implementation spans data-plat-session.ts, data-plat-state.ts, McpManager, tool-policy, Gateway, AppRepository, DataPlatFields, and useChatStream. Tests cover schemas, sessions, repository, UI, and Gateway. HTTP tests use the actual SDK with a local fixture; isolated Java tests and production-model acceptance are separate evidence layers.

Run pnpm check and pnpm build after changes, and synchronize the companion skill package documentation, contracts, and tests. Offline tests do not replace enterprise-issuer or real business-model acceptance.
