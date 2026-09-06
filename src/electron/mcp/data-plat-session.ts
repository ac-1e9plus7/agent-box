import { createHash } from 'node:crypto'
import type { McpServerConfig } from '../../shared/types'
import type { DataPlatOperation } from './data-plat-state'
import { DATA_PLAT_TOOLS } from './data-plat-state'
import type { McpToolExecutionResult } from './mcp-client'
import { t } from '../../shared/i18n'
import { isLoopbackUrl } from '../api/provider-policy'

type Args = Record<string, unknown>
export interface DataPlatRepository {
  getMcpServer(id: string): McpServerConfig | undefined
  listDataPlatOperations(conversationId: string): DataPlatOperation[]
  recordDataPlatOperation(operation: DataPlatOperation): Promise<void>
}
export interface DataPlatTransport {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  call(
    server: McpServerConfig,
    token: string,
    tool: string,
    args: Args,
    signal: AbortSignal,
  ): Promise<McpToolExecutionResult>
}
export interface DataPlatApproval {
  args: Args
  summary: Args
  serverId: string
  tool: string
  fingerprint: string
}
const EXECUTIONS = new Set(['query_run', 'report_run', 'query_cancel'])
const SCOPES = [
  'agent.catalog.read',
  'agent.access.explain',
  'agent.query.plan',
  'agent.query.execute',
  'agent.report.read',
  'agent.report.execute',
]
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const record = (value: unknown): value is Args => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const fail = () =>
  new Error(
    t('Data platform operation could not be verified. Check the connection, permissions, and plan, then try again.'),
  )

function identity(server: McpServerConfig): string {
  return hash([server.id, server.url, server.dataPlat?.apiBaseUrl, server.dataPlat?.agentId])
}
function fingerprint(server: McpServerConfig): string {
  return hash([identity(server), server.dataPlat?.loginToken, server.headers])
}

export function normalizeDataPlatExecution(tool: string, input: Args): Args {
  const allowed =
    tool === 'query_cancel'
      ? ['executionId']
      : tool === 'query_run'
        ? ['planId', 'planHash', 'executionMode', 'pageSize']
        : ['reportId', 'planId', 'planHash', 'pageSize']
  if (!EXECUTIONS.has(tool) || Object.keys(input).some((key) => !allowed.includes(key))) throw fail()
  if (tool === 'query_cancel') {
    if (typeof input.executionId !== 'string' || !/^qry_[A-Za-z0-9_-]{8,60}$/.test(input.executionId)) throw fail()
    return { executionId: input.executionId }
  }
  if (typeof input.planId !== 'string' || !input.planId || typeof input.planHash !== 'string' || !input.planHash)
    throw fail()
  const pageSize = input.pageSize ?? 100
  if (!Number.isInteger(pageSize) || Number(pageSize) < 1 || Number(pageSize) > 100) throw fail()
  const result: Args = { planId: input.planId, planHash: input.planHash, pageSize }
  if (tool === 'query_run') {
    if (input.executionMode != null && input.executionMode !== 'INLINE') throw fail()
    result.executionMode = 'INLINE'
  } else {
    if (!Number.isSafeInteger(input.reportId) || Number(input.reportId) < 1) throw fail()
    result.reportId = input.reportId
  }
  return result
}

/** A bounded control-plane request. Tokens and upstream error bodies never leave this module. */
export async function dataPlatControlRequest(
  transport: Pick<DataPlatTransport, 'fetch'>,
  server: McpServerConfig,
  path: string,
  body: Args,
  signal: AbortSignal,
): Promise<Args> {
  const config = server.dataPlat
  if (!config) throw fail()
  for (const address of [config.apiBaseUrl, server.url]) {
    if (!address) throw fail()
    const url = new URL(address)
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackUrl(address)))
    )
      throw fail()
  }
  if (
    server.transport !== 'http' ||
    !['confirmations', 'delegations/mcp-token'].includes(path) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(config.agentId) ||
    !config.loginToken ||
    /[\r\n]/.test(config.loginToken)
  )
    throw fail()
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15000)])
  try {
    const response = await transport.fetch(`${config.apiBaseUrl}/api/agent/v1/${path}`, {
      method: 'POST',
      redirect: 'error',
      signal: requestSignal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.loginToken}`,
        'X-Agent-Id': config.agentId,
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw fail()
    }
    const reader = response.body?.getReader()
    if (!reader) throw fail()
    let size = 0
    const chunks: Uint8Array[] = []
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.byteLength
        if (size > 262144) {
          await reader.cancel()
          throw fail()
        }
        chunks.push(next.value)
      }
    } finally {
      reader.releaseLock()
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!record(parsed) || !record(parsed.data)) throw fail()
    return parsed.data
  } catch {
    if (signal.aborted) throw signal.reason ?? fail()
    throw fail()
  }
}

export async function dataPlatToken(
  transport: Pick<DataPlatTransport, 'fetch'>,
  server: McpServerConfig,
  signal: AbortSignal,
  confirmationToken?: string,
): Promise<string> {
  const response = await dataPlatControlRequest(
    transport,
    server,
    'delegations/mcp-token',
    {
      agentId: server.dataPlat?.agentId,
      scopes: SCOPES,
      ...(confirmationToken ? { confirmationToken } : {}),
    },
    signal,
  )
  if (
    typeof response.accessToken !== 'string' ||
    !response.accessToken ||
    response.accessToken.length > 16384 ||
    response.audience !== 'data-plat-mcp'
  )
    throw fail()
  return response.accessToken
}

/** One instance per Gateway request. Plan facts and approval capabilities cannot cross requests. */
export class DataPlatSession {
  private readonly plans = new Map<string, { data: Args; fingerprint: string }>()
  private readonly approvals = new WeakSet<DataPlatApproval>()
  constructor(
    private readonly repository: DataPlatRepository,
    private readonly transport: DataPlatTransport,
    private readonly conversationId: string,
    private readonly signal: AbortSignal,
  ) {}

  isManaged(serverId: string): boolean {
    return Boolean(this.repository.getMcpServer(serverId)?.dataPlat)
  }
  private server(id: string): McpServerConfig {
    this.signal.throwIfAborted()
    const server = this.repository.getMcpServer(id)
    if (!server?.enabled || !server.dataPlat || server.transport !== 'http') throw fail()
    return server
  }
  private key(server: McpServerConfig, tool: string, args: Args): string {
    // A plan cannot be executed again by changing pageSize or a model tool-call ID.
    return hash([identity(server), this.conversationId, tool, args.planId ?? args.executionId])
  }

  async prepare(serverId: string, tool: string, input: Args): Promise<DataPlatApproval | undefined> {
    if (!this.isManaged(serverId) || !EXECUTIONS.has(tool)) return undefined
    const server = this.server(serverId)
    const args = normalizeDataPlatExecution(tool, input)
    let summary: Args
    if (tool === 'query_cancel') {
      const result = await this.execute(serverId, 'query_status', { executionId: args.executionId })
      if (result.isError || !record(result.structuredContent?.data)) throw fail()
      // Do not include result rows in a cancellation approval card.
      const status = result.structuredContent.data
      summary = { executionId: args.executionId, status: status.status }
    } else {
      const plan = this.plans.get(`${serverId}:${String(args.planId)}`)
      if (
        !plan ||
        plan.fingerprint !== fingerprint(server) ||
        plan.data.planHash !== args.planHash ||
        Date.parse(String(plan.data.expiresAt)) <= Date.now()
      )
        throw fail()
      if (tool === 'report_run' && (plan.data.sourceType !== 'REPORT' || plan.data.sourceId !== args.reportId))
        throw fail()
      if (tool === 'query_run' && plan.data.sourceType === 'REPORT') throw fail()
      summary = Object.fromEntries(
        [
          'planId',
          'planHash',
          'normalizedQuery',
          'assetNames',
          'sourceType',
          'sourceId',
          'expiresAt',
          'executionPolicy',
          'checks',
        ].map((key) => [key, plan.data[key]]),
      )
    }
    if (JSON.stringify(summary).length > 32000) throw fail()
    const approval = { serverId, tool, args, summary, fingerprint: fingerprint(server) }
    this.approvals.add(approval)
    return approval
  }

  async execute(
    serverId: string,
    tool: string,
    input: Args,
    approved?: DataPlatApproval,
  ): Promise<McpToolExecutionResult> {
    const server = this.server(serverId)
    const boundFingerprint = fingerprint(server)
    if (!DATA_PLAT_TOOLS.has(tool)) throw fail()
    let args = input
    let token: string
    let confirmationSecret: string | undefined
    if (EXECUTIONS.has(tool)) {
      args = normalizeDataPlatExecution(tool, input)
      if (
        !approved ||
        !this.approvals.delete(approved) ||
        approved.serverId !== serverId ||
        approved.tool !== tool ||
        approved.fingerprint !== fingerprint(server) ||
        hash(approved.args) !== hash(args)
      )
        throw fail()
      const prior = this.repository
        .listDataPlatOperations(this.conversationId)
        .find((op) => op.key === this.key(server, tool, args))
      if (prior) return this.execute(serverId, 'query_status', { executionId: prior.executionId })
      // Recheck TTL after the user has spent time reading the card.
      if (tool !== 'query_cancel' && Date.parse(String(approved.summary.expiresAt)) <= Date.now()) throw fail()
      const confirmation = await dataPlatControlRequest(
        this.transport,
        server,
        'confirmations',
        { toolName: tool, arguments: args },
        this.signal,
      )
      if (
        typeof confirmation.confirmationToken !== 'string' ||
        typeof confirmation.executionId !== 'string' ||
        confirmation.toolName !== tool ||
        !record(confirmation.arguments) ||
        hash(normalizeDataPlatExecution(tool, confirmation.arguments)) !== hash(args)
      )
        throw fail()
      // Configuration may have changed while confirmation was in flight.
      if (fingerprint(this.server(serverId)) !== approved.fingerprint) throw fail()
      token = await dataPlatToken(this.transport, server, this.signal, confirmation.confirmationToken)
      confirmationSecret = confirmation.confirmationToken
      if (fingerprint(this.server(serverId)) !== approved.fingerprint) throw fail()
      await this.repository.recordDataPlatOperation({
        key: this.key(server, tool, args),
        conversationId: this.conversationId,
        serverId,
        identity: identity(server),
        toolName: tool,
        executionId: confirmation.executionId,
        planId: String(args.planId ?? ''),
        createdAt: new Date().toISOString(),
      })
    } else token = await dataPlatToken(this.transport, server, this.signal)
    this.signal.throwIfAborted()
    if (fingerprint(this.server(serverId)) !== boundFingerprint) throw fail()
    let rawResult: McpToolExecutionResult
    try {
      rawResult = await this.transport.call(server, token, tool, args, this.signal)
    } catch {
      this.signal.throwIfAborted()
      throw fail()
    }
    const secrets = [server.dataPlat?.loginToken, token, confirmationSecret].filter((secret): secret is string =>
      Boolean(secret),
    )
    const result = JSON.parse(
      JSON.stringify(rawResult, (_key, value: unknown) =>
        typeof value === 'string'
          ? secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), value)
          : value,
      ),
    ) as McpToolExecutionResult
    if (fingerprint(this.server(serverId)) !== boundFingerprint) throw fail()
    if (!result.isError && (tool === 'query_plan' || tool === 'report_plan')) {
      const data = result.structuredContent?.data
      if (
        !record(data) ||
        typeof data.planId !== 'string' ||
        typeof data.planHash !== 'string' ||
        !record(data.normalizedQuery) ||
        !Number.isFinite(Date.parse(String(data.expiresAt))) ||
        result.truncated
      )
        throw fail()
      if (this.plans.size >= 100) throw fail()
      this.plans.set(`${serverId}:${data.planId}`, { data: structuredClone(data), fingerprint: fingerprint(server) })
    }
    return result
  }

  async refresh(serverIds: string[]): Promise<string> {
    const operations = this.repository
      .listDataPlatOperations(this.conversationId)
      .filter((op) => serverIds.includes(op.serverId))
      .slice(-5)
    const refreshed: Args[] = []
    const seen = new Set<string>()
    for (const op of operations) {
      if (seen.has(op.executionId)) continue
      seen.add(op.executionId)
      try {
        const server = this.server(op.serverId)
        if (identity(server) !== op.identity) continue
        const result = await this.execute(op.serverId, 'query_status', { executionId: op.executionId })
        refreshed.push({
          executionId: op.executionId,
          ...(!result.isError && result.structuredContent
            ? { current: result.structuredContent }
            : { unavailable: true }),
        })
      } catch {
        this.signal.throwIfAborted()
        refreshed.push({ executionId: op.executionId, unavailable: true })
      }
    }
    return JSON.stringify(refreshed)
  }
}
