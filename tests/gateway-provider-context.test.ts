import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ChatRequest, StreamEvent } from '../src/shared/types'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8'),
  },
}))

const { AppRepository } = await import('../src/electron/storage/app-repository')
const { McpManager } = await import('../src/electron/mcp/mcp-manager')
const { ChatGateway } = await import('../src/electron/api/gateway')

function makeSseResponse(events: Array<{ event?: string; data: unknown }>): Response {
  const chunks = events.map(({ event, data }) => {
    const eventLine = event ? `event: ${event}\n` : ''
    return `${eventLine}data: ${data === '[DONE]' ? data : JSON.stringify(data)}\n\n`
  })
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

function completedResponse(responseId: string, text: string): Response {
  return makeSseResponse([
    { event: 'response.created', data: { type: 'response.created', response: { id: responseId } } },
    { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: text } },
    {
      event: 'response.completed',
      data: { type: 'response.completed', response: { id: responseId, status: 'completed' } },
    },
    { data: '[DONE]' },
  ])
}

describe('ChatGateway provider context optimization', () => {
  let tempDirectory: string
  let repo: InstanceType<typeof AppRepository>
  let mcpManager: InstanceType<typeof McpManager>
  let gateway: InstanceType<typeof ChatGateway>
  let modelId: string

  beforeAll(async () => {
    tempDirectory = mkdtempSync(join(tmpdir(), 'agentbox-provider-context-test-'))
    repo = new AppRepository(tempDirectory)
    await repo.initialize()
    const provider = await repo.upsertProvider({
      name: 'Direct OpenAI',
      kind: 'openai',
      apiFormat: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-provider-context',
    })
    const model = await repo.upsertModel({
      name: 'Responses Model',
      remoteId: 'gpt-test',
      providerId: provider.id,
      apiFormat: 'openai-responses',
      contextWindow: 128_000,
      maxOutputTokens: 4_096,
      supportsReasoning: false,
      defaultReasoningEnabled: false,
      defaultReasoningEffort: 'medium',
    })
    modelId = model.id
    await repo.updateSettings({
      mcpToolApprovalPolicy: 'full-access',
      agentProviderContextOptimizationMode: 'auto',
    })
    mcpManager = new McpManager(repo)
    gateway = new ChatGateway(repo, mcpManager)
  })

  afterAll(async () => {
    await mcpManager.closeAll()
    repo.destroy()
    rmSync(tempDirectory, { recursive: true, force: true })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await repo.updateSettings({ agentProviderContextOptimizationMode: 'auto' })
  })

  it('uses Responses native continuation between Agent tool turns', async () => {
    vi.spyOn(mcpManager, 'listAllTools').mockResolvedValue([
      {
        name: 'lookup_context',
        description: 'Look up context for a question',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
        serverId: 'context-server',
        serverName: 'Context Server',
      },
    ])
    vi.spyOn(mcpManager, 'executeTool').mockResolvedValue({
      result: 'native continuation result',
      isError: false,
      serverName: 'Context Server',
    })

    const bodies: Array<Record<string, unknown>> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      if (bodies.length === 1) {
        return makeSseResponse([
          { event: 'response.created', data: { type: 'response.created', response: { id: 'resp_turn_1' } } },
          {
            event: 'response.output_item.added',
            data: {
              type: 'response.output_item.added',
              output_index: 0,
              item: {
                type: 'function_call',
                id: 'fc_1',
                call_id: 'call_context_1',
                name: 'lookup_context',
                arguments: '{"q":"question"}',
              },
            },
          },
          {
            event: 'response.completed',
            data: { type: 'response.completed', response: { id: 'resp_turn_1', status: 'completed' } },
          },
          { data: '[DONE]' },
        ])
      }
      return completedResponse('resp_turn_2', 'Done with native continuation.')
    })

    const events: StreamEvent[] = []
    await gateway.stream(
      'request-native-context',
      {
        conversationId: 'conversation-native-context',
        modelId,
        messages: [
          {
            id: 'user-native-context',
            role: 'user',
            content: 'Use lookup_context for this question.',
            createdAt: new Date().toISOString(),
          },
        ],
        agentMode: true,
        reasoningEnabled: false,
      },
      (event) => events.push(event),
    )

    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toMatchObject({ store: true })
    expect(bodies[0]?.prompt_cache_key).toMatch(/^[a-f0-9]{64}$/)
    expect(bodies[1]).toMatchObject({
      store: true,
      previous_response_id: 'resp_turn_1',
      input: [
        {
          type: 'function_call_output',
          call_id: 'call_context_1',
          output: 'native continuation result',
        },
      ],
    })
    expect(
      events.filter((event) => event.type === 'provider-continuation').map((event) => event.continuation.responseId),
    ).toEqual(['resp_turn_1', 'resp_turn_2'])
  })

  it('degrades native continuation to prefix caching and then stateless replay', async () => {
    await repo.updateSettings({ agentProviderContextOptimizationMode: 'native-continuation' })
    vi.spyOn(mcpManager, 'listAllTools').mockResolvedValue([])
    const bodies: Array<Record<string, unknown>> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.push(body)
      if (bodies.length === 1) {
        return new Response(
          JSON.stringify({ error: { message: 'Unknown parameter: previous_response_id', code: 'unsupported' } }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (bodies.length === 2) {
        return new Response(
          JSON.stringify({ error: { message: 'Unknown parameter: prompt_cache_key', code: 'unsupported' } }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return completedResponse('resp_stateless', 'Fallback completed.')
    })

    const request: ChatRequest = {
      conversationId: 'conversation-fallback-context',
      modelId,
      messages: [
        { id: 'old-user', role: 'user', content: 'Old question', createdAt: new Date().toISOString() },
        {
          id: 'old-assistant',
          role: 'assistant',
          content: 'Old answer',
          modelId,
          providerContinuation: { format: 'openai-responses', responseId: 'resp_old', turn: 1 },
          createdAt: new Date().toISOString(),
        },
        { id: 'new-user', role: 'user', content: 'New question', createdAt: new Date().toISOString() },
      ],
      agentMode: true,
      reasoningEnabled: false,
    }
    const events: StreamEvent[] = []
    await gateway.stream('request-fallback-context', request, (event) => events.push(event))

    expect(bodies).toHaveLength(3)
    expect(bodies[0]).toMatchObject({ previous_response_id: 'resp_old', store: true })
    expect(bodies[1]?.previous_response_id).toBeUndefined()
    expect(bodies[1]?.prompt_cache_key).toMatch(/^[a-f0-9]{64}$/)
    expect(bodies[2]?.previous_response_id).toBeUndefined()
    expect(bodies[2]?.prompt_cache_key).toBeUndefined()
    expect(bodies[2]?.store).toBeUndefined()
    expect(events.some((event) => event.type === 'text-delta' && event.delta === 'Fallback completed.')).toBe(true)
    expect(events.some((event) => event.type === 'error')).toBe(false)
  })

  it('uses prefix caching on the next tool turn when a native response omits its response ID', async () => {
    vi.spyOn(mcpManager, 'listAllTools').mockResolvedValue([
      {
        name: 'lookup_without_response_id',
        description: 'Look up context when a provider omits response IDs',
        inputSchema: { type: 'object', properties: {} },
        serverId: 'missing-id-server',
        serverName: 'Missing ID Server',
      },
    ])
    vi.spyOn(mcpManager, 'executeTool').mockResolvedValue({
      result: 'lookup complete',
      isError: false,
      serverName: 'Missing ID Server',
    })
    const bodies: Array<Record<string, unknown>> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      if (bodies.length === 1) {
        return makeSseResponse([
          {
            event: 'response.output_item.added',
            data: {
              type: 'response.output_item.added',
              output_index: 0,
              item: {
                type: 'function_call',
                call_id: 'call_missing_id',
                name: 'lookup_without_response_id',
                arguments: '{}',
              },
            },
          },
          { event: 'response.completed', data: { type: 'response.completed', response: { status: 'completed' } } },
          { data: '[DONE]' },
        ])
      }
      return completedResponse('resp_after_missing_id', 'Completed through prefix fallback.')
    })

    await gateway.stream(
      'request-missing-native-id',
      {
        conversationId: 'conversation-missing-native-id',
        modelId,
        messages: [
          {
            id: 'user-missing-native-id',
            role: 'user',
            content: 'Use lookup_without_response_id.',
            createdAt: new Date().toISOString(),
          },
        ],
        agentMode: true,
        reasoningEnabled: false,
      },
      () => {},
    )

    expect(bodies).toHaveLength(2)
    expect(bodies[0]?.store).toBe(true)
    expect(bodies[1]?.store).toBeUndefined()
    expect(bodies[1]?.previous_response_id).toBeUndefined()
    expect(bodies[1]?.prompt_cache_key).toMatch(/^[a-f0-9]{64}$/)
  })
})
