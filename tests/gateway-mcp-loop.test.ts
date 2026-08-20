import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

function makeSseResponse(chunks: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk))
      }
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

describe('ChatGateway Multi-turn MCP Tool Loop', () => {
  let tempDirectory: string
  let repo: InstanceType<typeof AppRepository>
  let mcpManager: InstanceType<typeof McpManager>
  let gateway: InstanceType<typeof ChatGateway>

  beforeAll(async () => {
    tempDirectory = mkdtempSync(join(tmpdir(), 'agentbox-gateway-mcp-test-'))
    repo = new AppRepository(tempDirectory)
    await repo.initialize()
    await repo.updateSettings({ mcpToolApprovalPolicy: 'never' })

    // Add a model and provider
    const provider = await repo.upsertProvider({
      name: 'Test OpenRouter',
      kind: 'openrouter',
      apiFormat: 'openai-chat-completions',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-test-key-123',
    })
    await repo.upsertModel({
      name: 'Test Auto Model',
      remoteId: 'test/auto-model',
      providerId: provider.id,
      contextWindow: 128_000,
      maxOutputTokens: 4_096,
      supportsReasoning: false,
      defaultReasoningEnabled: false,
      defaultReasoningEffort: 'medium',
    })

    mcpManager = new McpManager(repo)
    gateway = new ChatGateway(repo, mcpManager)
  })

  afterAll(async () => {
    if (mcpManager) await mcpManager.closeAll()
    if (repo) repo.destroy()
    rmSync(tempDirectory, { recursive: true, force: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('runs multi-turn tool execution loop when model requests a tool call', async () => {
    // Register mock tool in mcpManager
    vi.spyOn(mcpManager, 'listAllTools').mockResolvedValue([
      {
        name: 'calculate_sum',
        description: 'Add two numbers together',
        inputSchema: {
          type: 'object',
          properties: { a: { type: 'number' }, b: { type: 'number' } },
        },
        serverId: 'calc-srv',
        serverName: 'Calculator Server',
      },
    ])
    vi.spyOn(mcpManager, 'executeTool').mockResolvedValue({
      result: 'Sum is: 42',
      isError: false,
      serverName: 'Calculator Server',
    })

    // Turn 1 SSE: Model outputs tool call
    const turn1Chunk1 = 'data: ' + JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_calc_999',
                type: 'function',
                function: { name: 'calculate_sum', arguments: '{"a": 20, ' },
              },
            ],
          },
        },
      ],
    }) + '\n\n'

    const turn1Chunk2 = 'data: ' + JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: '"b": 22}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }) + '\n\n'

    const turn1Chunk3 = 'data: [DONE]\n\n'

    // Turn 2 SSE: Model outputs final answer text
    const turn2Chunk1 = 'data: ' + JSON.stringify({
      choices: [
        {
          delta: { content: 'The calculation result is 42.' },
        },
      ],
    }) + '\n\n'

    const turn2Chunk2 = 'data: ' + JSON.stringify({
      choices: [
        {
          delta: {},
          finish_reason: 'stop',
        },
      ],
    }) + '\n\n'

    const turn2Chunk3 = 'data: [DONE]\n\n'

    let callCount = 0
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        return makeSseResponse([turn1Chunk1, turn1Chunk2, turn1Chunk3])
      }
      return makeSseResponse([turn2Chunk1, turn2Chunk2, turn2Chunk3])
    })

    const events: StreamEvent[] = []
    const emit = (event: StreamEvent) => {
      events.push(event)
    }

    const createdModel = repo.listModels().find(m => m.remoteId === 'test/auto-model')!
    const request: ChatRequest = {
      conversationId: 'conv-test-1',
      modelId: createdModel.id,
      messages: [
        {
          id: 'msg-user-1',
          role: 'user',
          content: 'Use calculate_sum to calculate 20 + 22.',
          createdAt: new Date().toISOString(),
        },
      ],
      agentMode: true,
      reasoningEnabled: false,
    }

    await gateway.stream('req-mcp-loop-1', request, emit)

    const errEvent = events.find(e => e.type === 'error')
    if (errEvent) {
      console.error('GATEWAY ERROR EVENT:', errEvent)
    }

    expect(globalFetch).toHaveBeenCalledTimes(2)

    // Verify stream events
    expect(events.some((e) => e.type === 'start')).toBe(true)
    expect(events.some((e) => e.type === 'tool-call-start' && e.callId === 'call_calc_999')).toBe(true)
    expect(events.some((e) => e.type === 'tool-call-args' && e.delta.includes('"b": 22}'))).toBe(true)
    expect(events.some((e) => e.type === 'tool-call-complete' && (e as any).args.a === 20)).toBe(true)
    expect(events.some((e) => e.type === 'tool-result' && (e as any).result === 'Sum is: 42')).toBe(true)
    expect(events.some((e) => e.type === 'text-delta' && (e as any).delta === 'The calculation result is 42.')).toBe(true)
    expect(events.some((e) => e.type === 'done')).toBe(true)

  })

  it('waits for explicit approval before executing a sensitive tool', async () => {
    await repo.updateSettings({ mcpToolApprovalPolicy: 'always' })
    vi.spyOn(mcpManager, 'listAllTools').mockResolvedValue([{
      name: 'send_email',
      modelName: 'mcp_mail_send_email',
      description: 'Send an email',
      inputSchema: {
        type: 'object',
        properties: { to: { type: 'string' } },
        required: ['to'],
      },
      serverId: 'mail-server',
      serverName: 'Mail',
    }])
    const execute = vi.spyOn(mcpManager, 'executeTool').mockResolvedValue({
      result: 'sent',
      isError: false,
      serverName: 'Mail',
    })
    let fetchCount = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      fetchCount += 1
      if (fetchCount === 1) {
        return makeSseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-mail', function: { name: 'mcp_mail_send_email', arguments: '{"to":"a@example.com"}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`,
          'data: [DONE]\n\n',
        ])
      }
      return makeSseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'Email sent.' }, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      ])
    })

    let resolveApproval!: (event: Extract<StreamEvent, { type: 'tool-approval-required' }>) => void
    const approval = new Promise<Extract<StreamEvent, { type: 'tool-approval-required' }>>((resolve) => {
      resolveApproval = resolve
    })
    const events: StreamEvent[] = []
    const stream = gateway.stream('req-approval', {
      conversationId: 'conversation-approval',
      modelId: repo.listModels().find((item) => item.remoteId === 'test/auto-model')!.id,
      messages: [{ id: 'user-approval', role: 'user', content: 'Use send_email to contact a@example.com', createdAt: new Date().toISOString() }],
      agentMode: true,
      reasoningEnabled: false,
    }, (event) => {
      events.push(event)
      if (event.type === 'tool-approval-required') resolveApproval(event)
    })

    const approvalEvent = await approval
    expect(execute).not.toHaveBeenCalled()
    expect(approvalEvent.args).toEqual({ to: 'a@example.com' })
    gateway.resolveToolApproval('req-approval', 'call-mail', true)
    await stream
    expect(execute).toHaveBeenCalledTimes(1)
    expect(events.some((event) => event.type === 'done')).toBe(true)
    await repo.updateSettings({ mcpToolApprovalPolicy: 'never' })
  })

  it('executes at most six tool turns and always emits a terminal event', async () => {
    await repo.updateSettings({ mcpToolApprovalPolicy: 'never' })
    vi.spyOn(mcpManager, 'listAllTools').mockResolvedValue([{
      name: 'loop_tool',
      modelName: 'mcp_loop_tool',
      description: 'Loop tool',
      inputSchema: { type: 'object', properties: {} },
      serverId: 'loop-server',
      serverName: 'Loop',
    }])
    const execute = vi.spyOn(mcpManager, 'executeTool').mockResolvedValue({
      result: 'continue',
      isError: false,
      serverName: 'Loop',
    })
    let fetchCount = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      fetchCount += 1
      return makeSseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call-loop-${fetchCount}`, function: { name: 'mcp_loop_tool', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`,
        'data: [DONE]\n\n',
      ])
    })
    const events: StreamEvent[] = []
    await gateway.stream('req-loop-limit', {
      conversationId: 'conversation-loop-limit',
      modelId: repo.listModels().find((item) => item.remoteId === 'test/auto-model')!.id,
      messages: [{ id: 'user-loop', role: 'user', content: 'Use loop_tool repeatedly', createdAt: new Date().toISOString() }],
      agentMode: true,
      reasoningEnabled: false,
    }, (event) => events.push(event))

    expect(fetchCount).toBe(7)
    expect(execute).toHaveBeenCalledTimes(6)
    expect(events.some((event) => event.type === 'done' && event.finishReason === 'tool_turn_limit')).toBe(true)
  })
})
