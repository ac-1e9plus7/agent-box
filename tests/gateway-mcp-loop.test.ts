import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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
          content: 'What is 20 + 22?',
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

    globalFetch.mockRestore()
  })
})
