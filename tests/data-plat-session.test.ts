import { describe, it, expect, vi } from 'vitest'
import {
  DataPlatSession,
  normalizeDataPlatExecution,
  dataPlatControlRequest,
  type DataPlatRepository,
  type DataPlatTransport,
} from '../src/electron/mcp/data-plat-session'
import {
  dataPlatUserHistory,
  parseDataPlatOperations,
  type DataPlatOperation,
} from '../src/electron/mcp/data-plat-state'
import type { McpServerConfig, Message } from '../src/shared/types'

function setup() {
  const server: McpServerConfig = {
    id: 'data',
    name: 'data',
    enabled: true,
    transport: 'http',
    url: 'http://localhost:8081/mcp',
    dataPlat: { apiBaseUrl: 'http://localhost:8080', agentId: 'agentbox', loginToken: 'synthetic-login' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  const operations: DataPlatOperation[] = []
  const repository: DataPlatRepository = {
    getMcpServer: () => server,
    listDataPlatOperations: (id) => operations.filter((op) => op.conversationId === id),
    recordDataPlatOperation: async (op) => {
      operations.push(op)
    },
  }
  const plan = {
    planId: 'plan-test',
    planHash: 'hash-test',
    sourceType: 'QUERY',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    normalizedQuery: { datasetId: 1, select: [{ type: 'METRIC', id: 2 }] },
    executionPolicy: { effectiveMaxRows: 100 },
  }
  const fetch = vi.fn<DataPlatTransport['fetch']>(async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return Response.json({
      data: String(url).endsWith('/confirmations')
        ? {
            confirmationToken: 'synthetic-confirmation',
            executionId: 'qry_12345678',
            toolName: body.toolName,
            arguments: body.arguments,
          }
        : { accessToken: body.confirmationToken ? 'approved-obo' : 'read-obo', audience: 'data-plat-mcp' },
    })
  })
  const call = vi.fn<DataPlatTransport['call']>(async (_server, _token, tool, args) => ({
    result: 'ok',
    isError: false,
    structuredContent: {
      data:
        tool === 'query_plan'
          ? plan
          : {
              executionId: args.executionId ?? 'qry_12345678',
              status: 'COMPLETED',
              execution: { result: { rows: [[12]] } },
            },
    },
  }))
  const controller = new AbortController()
  const create = (id = 'conversation') => new DataPlatSession(repository, { fetch, call }, id, controller.signal)
  return { server, operations, repository, plan, fetch, call, controller, create }
}
const args = { planId: 'plan-test', planHash: 'hash-test' }

describe('data-plat exact execution boundary', () => {
  it('redacts known credentials echoed by an upstream tool in text or structured results', async () => {
    const f = setup()
    const session = f.create()
    f.call.mockResolvedValueOnce({
      result: 'synthetic-login read-obo',
      isError: false,
      structuredContent: { data: { nested: ['synthetic-login', 'read-obo'] } },
    })
    const result = await session.execute('data', 'catalog_search', {})
    expect(JSON.stringify(result)).not.toMatch(/synthetic-login|read-obo/)
    expect(result.result).toContain('[REDACTED]')
  })

  it('expires a plan while approval is pending and never contacts the confirmation endpoint', async () => {
    const f = setup()
    const session = f.create()
    await session.execute('data', 'query_plan', {})
    const approval = await session.prepare('data', 'query_run', args)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120000)
    try {
      await expect(session.execute('data', 'query_run', args, approval)).rejects.toThrow()
      expect(f.fetch.mock.calls.some((call) => String(call[0]).endsWith('/confirmations'))).toBe(false)
    } finally {
      clock.mockRestore()
    }
  })

  it('binds report execution to its actual report source and rejects query/report substitution', async () => {
    const f = setup()
    const session = f.create()
    f.call.mockResolvedValueOnce({
      result: 'plan',
      isError: false,
      structuredContent: { data: { ...f.plan, sourceType: 'REPORT', sourceId: 7 } },
    })
    await session.execute('data', 'report_plan', { reportId: 7 })
    await expect(session.prepare('data', 'query_run', args)).rejects.toThrow()
    await expect(session.prepare('data', 'report_run', { ...args, reportId: 8 })).rejects.toThrow()
    const reportArgs = { ...args, reportId: 7 }
    await session.execute('data', 'report_run', reportArgs, await session.prepare('data', 'report_run', reportArgs))
    expect(f.call.mock.calls.at(-1)?.[3]).toEqual({ ...args, pageSize: 100, reportId: 7 })
  })

  it('keeps concurrent requests isolated and does not overwrite server authentication headers', async () => {
    const f = setup()
    f.server.headers = { Authorization: 'static-value' }
    const first = f.create('one'),
      second = f.create('two')
    await Promise.all([first.execute('data', 'query_plan', {}), second.execute('data', 'query_plan', {})])
    const approvals = await Promise.all([
      first.prepare('data', 'query_run', args),
      second.prepare('data', 'query_run', args),
    ])
    await Promise.all([
      first.execute('data', 'query_run', args, approvals[0]),
      second.execute('data', 'query_run', args, approvals[1]),
    ])
    expect(f.operations.map((op) => op.conversationId).sort()).toEqual(['one', 'two'])
    expect(f.server.headers.Authorization).toBe('static-value')
  })

  it('rejects changed server normalization instead of silently approving different parameters', async () => {
    const f = setup()
    const session = f.create()
    await session.execute('data', 'query_plan', {})
    const approval = await session.prepare('data', 'query_run', args)
    f.fetch.mockResolvedValueOnce(
      Response.json({
        data: {
          confirmationToken: 'changed-confirmation',
          executionId: 'qry_12345678',
          toolName: 'query_run',
          arguments: { ...args, pageSize: 1, executionMode: 'INLINE' },
        },
      }),
    )
    await expect(session.execute('data', 'query_run', args, approval)).rejects.toThrow()
    expect(f.call.mock.calls.some((call) => call[2] === 'query_run')).toBe(false)
  })

  it('does not send login credentials when testing an insecure unsaved endpoint', async () => {
    const f = setup()
    f.server.dataPlat!.apiBaseUrl = 'http://remote.example'
    await expect(
      dataPlatControlRequest({ fetch: f.fetch }, f.server, 'confirmations', {}, f.controller.signal),
    ).rejects.toThrow()
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('requires a real current plan and an approved capability even under a permissive caller', async () => {
    const f = setup()
    const s = f.create()
    await expect(s.prepare('data', 'query_run', args)).rejects.toThrow()
    await s.execute('data', 'query_plan', { query: { datasetId: 1 } })
    await expect(s.execute('data', 'query_run', args)).rejects.toThrow()
    const approval = await s.prepare('data', 'query_run', args)
    await s.execute('data', 'query_run', args, approval)
    expect(f.call).toHaveBeenLastCalledWith(
      expect.anything(),
      'approved-obo',
      'query_run',
      { ...args, pageSize: 100, executionMode: 'INLINE' },
      expect.anything(),
    )
    expect(f.operations).toHaveLength(1)
    expect(JSON.stringify(f.operations)).not.toMatch(/synthetic|rows|confirmationToken|loginToken/)
    await expect(s.execute('data', 'query_run', args, approval)).rejects.toThrow()
  })
  it('recovers an uncertain execution by status instead of running the same plan again', async () => {
    const f = setup()
    const s = f.create()
    await s.execute('data', 'query_plan', {})
    f.call.mockResolvedValueOnce({ result: 'network unavailable', isError: true })
    await s.execute('data', 'query_run', args, await s.prepare('data', 'query_run', args))
    await s.execute(
      'data',
      'query_run',
      { ...args, pageSize: 20 },
      await s.prepare('data', 'query_run', { ...args, pageSize: 20 }),
    )
    expect(f.call.mock.calls.filter((c) => c[2] === 'query_run')).toHaveLength(1)
    expect(f.call.mock.calls.at(-1)?.[2]).toBe('query_status')
    expect(f.fetch.mock.calls.filter((c) => String(c[0]).endsWith('/confirmations'))).toHaveLength(1)
  })
  it('rejects parameter drift, credential changes, stale plans and foreign session approvals', async () => {
    const f = setup()
    const s = f.create()
    await s.execute('data', 'query_plan', {})
    const approval = await s.prepare('data', 'query_run', args)
    await expect(f.create('other').execute('data', 'query_run', args, approval)).rejects.toThrow()
    await expect(s.execute('data', 'query_run', { ...args, pageSize: 1 }, approval)).rejects.toThrow()
    const next = await s.prepare('data', 'query_run', args)
    f.server.dataPlat!.loginToken = 'changed-login'
    await expect(s.execute('data', 'query_run', args, next)).rejects.toThrow()
    await expect(s.prepare('data', 'query_run', args)).rejects.toThrow()
  })
  it('records the stable execution before dispatch and prevents dispatch if journal persistence fails', async () => {
    const f = setup()
    const s = f.create()
    await s.execute('data', 'query_plan', {})
    f.repository.recordDataPlatOperation = async () => {
      throw new Error('storage failure')
    }
    await expect(s.execute('data', 'query_run', args, await s.prepare('data', 'query_run', args))).rejects.toThrow(
      'storage failure',
    )
    expect(f.call.mock.calls.some((c) => c[2] === 'query_run')).toBe(false)
  })
  it('refreshes only allowed references and never substitutes cached results on failure', async () => {
    const f = setup()
    const s = f.create()
    await s.execute('data', 'query_plan', {})
    await s.execute('data', 'query_run', args, await s.prepare('data', 'query_run', args))
    expect(await f.create().refresh([])).toBe('[]')
    f.call.mockResolvedValueOnce({ result: 'permission denied', isError: true })
    const result = await f.create().refresh(['data'])
    expect(result).toContain('unavailable')
    expect(result).not.toContain('rows')
  })
  it('cancels only after an exact execution confirmation and preserves the server state', async () => {
    const f = setup()
    const s = f.create()
    const cancel = { executionId: 'qry_12345678' }
    const approval = await s.prepare('data', 'query_cancel', cancel)
    expect(JSON.stringify(approval?.summary)).not.toContain('rows')
    const result = await s.execute('data', 'query_cancel', cancel, approval)
    expect(result.structuredContent?.data).toMatchObject({ status: 'COMPLETED' })
  })
  it('strips all previous assistant derivatives and provider handles from fresh requests', () => {
    const history: Message[] = [
      { id: 'u', createdAt: '2026-09-06T00:00:00Z', role: 'user', content: 'compare sales' },
      {
        id: 'a',
        createdAt: '2026-09-06T00:00:00Z',
        role: 'assistant',
        content: 'secret old rows',
        reasoning: 'old reasoning',
        providerContinuation: { format: 'openai-responses', responseId: 'r', turn: 1 },
        agentTrace: [{ type: 'assistant_text', text: 'old data', turn: 1 }],
      },
    ]
    expect(dataPlatUserHistory(history)).toEqual([
      { id: 'u', createdAt: '2026-09-06T00:00:00Z', role: 'user', content: 'compare sales', attachments: undefined },
    ])
    expect(history[1]?.content).toBe('secret old rows')
  })
  it('rejects unbounded or invalid execution arguments and journal entries', () => {
    expect(() => normalizeDataPlatExecution('query_run', { ...args, pageSize: 101 })).toThrow()
    expect(() => normalizeDataPlatExecution('query_run', { ...args, executionId: 'qry_fakefake' })).toThrow()
    expect(() => parseDataPlatOperations([{ executionId: 'invalid' }])).toThrow()
  })
  it('bounds control responses and does not expose token-bearing transport errors', async () => {
    const f = setup()
    f.fetch.mockRejectedValueOnce(new Error('synthetic-login synthetic-confirmation'))
    await expect(
      dataPlatControlRequest({ fetch: f.fetch }, f.server, 'confirmations', {}, f.controller.signal),
    ).rejects.not.toThrow('synthetic-login')
    f.fetch.mockResolvedValueOnce(new Response('x'.repeat(262145)))
    await expect(
      dataPlatControlRequest({ fetch: f.fetch }, f.server, 'confirmations', {}, f.controller.signal),
    ).rejects.toThrow()
    f.controller.abort(new Error('cancelled'))
    await expect(f.create().execute('data', 'query_plan', {})).rejects.toThrow('cancelled')
  })
})
