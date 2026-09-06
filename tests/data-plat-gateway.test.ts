import { afterEach, describe, it, expect, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StreamEvent, McpToolParameterSchema } from '../src/shared/types'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (v: string) => Buffer.from(v),
    decryptString: (v: Buffer) => v.toString(),
  },
}))
const { AppRepository } = await import('../src/electron/storage/app-repository')
const { McpManager } = await import('../src/electron/mcp/mcp-manager')
const { ChatGateway } = await import('../src/electron/api/gateway')
const { createModelToolName } = await import('../src/electron/mcp/mcp-client')
const { agentCheckpointThreadId } = await import('../src/electron/storage/checkpoint-identity')
const contracts = JSON.parse(
  readFileSync(new URL('./fixtures/data-plat/agent-tools.json', import.meta.url), 'utf8'),
) as { name: string; inputSchema: McpToolParameterSchema; annotations: Record<string, boolean> }[]
const asRecord = (value: unknown) => value as Record<string, unknown>

function sse(delta: Record<string, unknown>, finish = 'stop'): Response {
  return new Response(
    'data: ' + JSON.stringify({ choices: [{ delta, finish_reason: finish }] }) + '\n\ndata: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  )
}

describe('Gateway → actual Streamable HTTP MCP transport → governed fixture', () => {
  const cleanup: (() => Promise<void> | void)[] = []
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const fn of cleanup.splice(0).reverse()) await fn()
  })
  async function fixture() {
    let confirmations = 0
    let runs = 0
    let revoked = false
    const seenAuth: string[] = []
    const plan = {
      planId: 'plan-fixture',
      planHash: 'hash-fixture',
      sourceType: 'QUERY',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      normalizedQuery: { datasetId: 1, select: [{ type: 'METRIC', id: 2 }] },
      assetNames: { 'metric:2': 'Sales' },
      executionPolicy: { effectiveMaxRows: 100 },
    }
    const server: Server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>
        const authorization = request.headers.authorization ?? ''
        seenAuth.push(authorization)
        response.setHeader('Content-Type', 'application/json')
        if (request.url?.includes('/api/agent/v1/')) {
          if (authorization !== 'Bearer synthetic-private-login') {
            response.writeHead(401)
            response.end('{}')
            return
          }
          if (request.url.endsWith('/confirmations')) {
            confirmations++
            response.end(
              JSON.stringify({
                data: {
                  confirmationToken: 'fixture-confirmation',
                  executionId: 'qry_12345678',
                  toolName: body.toolName,
                  arguments: body.arguments,
                },
              }),
            )
            return
          }
          response.end(
            JSON.stringify({
              data: {
                accessToken: body.confirmationToken ? 'fixture-approved-obo' : 'fixture-read-obo',
                audience: 'data-plat-mcp',
              },
            }),
          )
          return
        }
        if (!authorization.startsWith('Bearer fixture-')) {
          response.writeHead(401)
          response.end('{}')
          return
        }
        if (request.method !== 'POST') {
          response.writeHead(405)
          response.end('{}')
          return
        }
        if (body.id === undefined) {
          response.writeHead(202)
          response.end()
          return
        }
        let result: unknown = {}
        const params = asRecord(body.params ?? {})
        if (body.method === 'initialize')
          result = {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'Data fixture', version: '1.0.0' },
          }
        if (body.method === 'tools/list')
          result = {
            tools: contracts
              .filter((t) => ['query_plan', 'query_run', 'query_status'].includes(t.name))
              .map(({ name, inputSchema, annotations }) => ({ name, inputSchema, annotations })),
          }
        if (body.method === 'tools/call') {
          const name = params.name
          if (name === 'query_run') {
            if (authorization !== 'Bearer fixture-approved-obo') throw new Error('Unconfirmed run')
            runs++
          }
          result = revoked
            ? {
                isError: true,
                content: [{ type: 'text', text: 'AI_PROCESSING_DENIED' }],
                structuredContent: { ok: false, error: { code: 'AI_PROCESSING_DENIED' } },
              }
            : {
                isError: false,
                content: [{ type: 'text', text: 'Use structuredContent' }],
                structuredContent: {
                  data:
                    name === 'query_plan'
                      ? plan
                      : { executionId: 'qry_12345678', status: 'COMPLETED', execution: { result: { rows: [[42]] } } },
                },
              }
        }
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
      })().catch(() => {
        response.writeHead(500)
        response.end('{}')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(
      () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    )
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing address')
    const base = `http://127.0.0.1:${address.port}`
    const directory = mkdtempSync(join(tmpdir(), 'data-gateway-'))
    const repo = new AppRepository(directory)
    await repo.initialize()
    const manager = new McpManager(repo)
    const gateway = new ChatGateway(repo, manager)
    cleanup.push(async () => {
      await manager.closeAll()
      repo.destroy()
      rmSync(directory, { recursive: true, force: true })
    })
    await repo.updateSettings({ mcpToolApprovalPolicy: 'full-access', mcpToolRetrievalMode: 'all' })
    const data = await repo.upsertMcpServer({
      name: 'Data',
      transport: 'http',
      url: base + '/mcp',
      dataPlat: { apiBaseUrl: base, agentId: 'agentbox', loginToken: 'synthetic-private-login' },
    })
    const provider = await repo.upsertProvider({
      name: 'Model',
      kind: 'openai',
      apiFormat: 'openai-chat-completions',
      baseUrl: 'https://model-fixture.invalid/v1',
      apiKey: 'synthetic-model-key',
    })
    const model = await repo.upsertModel({
      name: 'Model',
      remoteId: 'fixture',
      providerId: provider.id,
      contextWindow: 128000,
      maxOutputTokens: 4096,
      supportsReasoning: false,
      defaultReasoningEnabled: false,
      defaultReasoningEffort: 'medium',
    })
    return {
      repo,
      manager,
      gateway,
      data,
      model,
      seenAuth,
      counts: () => ({ confirmations, runs }),
      revoke: () => {
        revoked = true
      },
    }
  }
  it.each([true, false])(
    'requires exact approval under Full Access (allow=%s) and keeps secrets out of model/history',
    async (allow) => {
      const f = await fixture()
      const networkFetch = globalThis.fetch
      let turn = 0
      const payloads: string[] = []
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        if (!String(input).startsWith('https://model-fixture.invalid')) return networkFetch(input, init)
        payloads.push(String(init?.body))
        turn++
        const name = turn === 1 ? 'query_plan' : turn === 2 ? 'query_run' : undefined
        const args =
          turn === 1
            ? { query: { datasetId: 1, select: [{ type: 'METRIC', id: 2 }] } }
            : { planId: 'plan-fixture', planHash: 'hash-fixture' }
        return name
          ? sse(
              {
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${turn}`,
                    type: 'function',
                    function: { name: createModelToolName(f.data.id, name), arguments: JSON.stringify(args) },
                  },
                ],
              },
              'tool_calls',
            )
          : sse({ content: 'Done' })
      })
      const request = {
        conversationId: 'conv',
        responseMessageId: 'answer',
        modelId: f.model.id,
        reasoningEnabled: false,
        agentMode: true,
        mcpServerIds: [f.data.id],
        messages: [{ id: 'user', role: 'user' as const, content: 'Query sales', createdAt: new Date().toISOString() }],
      }
      const events: StreamEvent[] = []
      await f.gateway.stream('first', request, (event) => {
        events.push(event)
        if (event.type === 'tool-approval-required')
          queueMicrotask(() => f.gateway.resolveToolApproval('first', event.callId, allow))
      })
      expect(events.filter((e) => e.type === 'error')).toEqual([])
      const approvals = events.filter((e) => e.type === 'tool-approval-required')
      expect(approvals).toHaveLength(1)
      expect(JSON.stringify(approvals[0])).toContain('normalizedQuery')
      expect(f.counts()).toEqual({ confirmations: allow ? 1 : 0, runs: allow ? 1 : 0 })
      expect(payloads.join('')).not.toMatch(/synthetic-private-login|fixture-approved-obo|fixture-confirmation/)
      expect(
        await f.repo.getAgentCheckpointSaver().getThreadDescriptor(agentCheckpointThreadId('conv', 'answer')),
      ).toBeUndefined()
      f.revoke()
      const before = payloads.length
      await f.gateway.stream(
        'second',
        {
          ...request,
          responseMessageId: 'answer-2',
          messages: [
            ...request.messages,
            { id: 'old', role: 'assistant', content: 'PRIVATE_OLD_ROW', createdAt: new Date().toISOString() },
            { id: 'next', role: 'user', content: 'Continue', createdAt: new Date().toISOString() },
          ],
        },
        () => undefined,
      )
      expect(payloads.slice(before).join('')).not.toContain('PRIVATE_OLD_ROW')
      if (allow) expect(payloads.slice(before).join('')).toContain('unavailable')
    },
  )
})
