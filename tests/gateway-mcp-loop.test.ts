import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
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
const { agentCheckpointThreadId } = await import('../src/electron/storage/checkpoint-identity')

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
    await repo.updateSettings({ mcpToolApprovalPolicy: 'full-access' })

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
    vi.useRealTimers()
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
    const turn1Chunk1 =
      'data: ' +
      JSON.stringify({
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
      }) +
      '\n\n'

    const turn1Chunk2 =
      'data: ' +
      JSON.stringify({
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
      }) +
      '\n\n'

    const turn1Chunk3 = 'data: [DONE]\n\n'

    // Turn 2 SSE: Model outputs final answer text
    const turn2Chunk1 =
      'data: ' +
      JSON.stringify({
        choices: [
          {
            delta: { content: 'The calculation result is 42.' },
          },
        ],
      }) +
      '\n\n'

    const turn2Chunk2 =
      'data: ' +
      JSON.stringify({
        choices: [
          {
            delta: {},
            finish_reason: 'stop',
          },
        ],
      }) +
      '\n\n'

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

    const createdModel = repo.listModels().find((m) => m.remoteId === 'test/auto-model')!
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

    const errEvent = events.find((e) => e.type === 'error')
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
    expect(events.some((e) => e.type === 'text-delta' && (e as any).delta === 'The calculation result is 42.')).toBe(
      true,
    )
    expect(events.some((e) => e.type === 'done')).toBe(true)
  })

  it('lets the model load a skill on demand without executing MCP', async () => {
    vi.spyOn(mcpManager, 'listAllTools').mockResolvedValue([])
    const execute = vi.spyOn(mcpManager, 'executeTool')
    const requestBodies: Array<Record<string, unknown>> = []
    let fetchCount = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      fetchCount += 1
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      if (fetchCount === 1) {
        return makeSseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-load-skill', function: { name: 'agentbox_load_skill', arguments: '{"skill_id":"translator-polyglot"}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`,
          'data: [DONE]\n\n',
        ])
      }
      return makeSseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'Skill loaded.' }, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      ])
    })

    const events: StreamEvent[] = []
    await gateway.stream(
      'req-skill-loader',
      {
        conversationId: 'conversation-skill-loader',
        modelId: repo.listModels().find((item) => item.remoteId === 'test/auto-model')!.id,
        messages: [
          {
            id: 'user-skill-loader',
            role: 'user',
            content: 'Choose a specialist workflow if needed.',
            createdAt: new Date().toISOString(),
          },
        ],
        agentMode: true,
        reasoningEnabled: false,
      },
      (event) => events.push(event),
    )

    expect(fetchCount).toBe(2)
    expect(execute).not.toHaveBeenCalled()
    expect(events).toContainEqual({
      type: 'skill-activated',
      requestId: 'req-skill-loader',
      skill: { id: 'translator-polyglot', name: '专业多语言精翻与本地化', source: 'model', turn: 1 },
    })
    expect(JSON.stringify(requestBodies[1])).toContain('三步翻译法')
    expect(
      events.some((event) => event.type === 'tool-result' && event.callId === 'call-load-skill' && !event.isError),
    ).toBe(true)
  })

  it('executes approved built-in JavaScript and returns the real result to the model', async () => {
    await repo.updateSettings({ mcpToolApprovalPolicy: 'full-access' })
    vi.spyOn(mcpManager, 'listAllTools').mockResolvedValue([])
    const executeMcp = vi.spyOn(mcpManager, 'executeTool')
    let fetchCount = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      fetchCount += 1
      if (fetchCount === 1) {
        return makeSseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-run-code', function: { name: 'agentbox_run_code', arguments: '{"language":"javascript","code":"console.log(6 * 7)"}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`,
          'data: [DONE]\n\n',
        ])
      }
      return makeSseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'The verified result is 42.' }, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      ])
    })

    const events: StreamEvent[] = []
    await gateway.stream(
      'req-run-code',
      {
        conversationId: 'conversation-run-code',
        modelId: repo.listModels().find((item) => item.remoteId === 'test/auto-model')!.id,
        messages: [
          { id: 'user-run-code', role: 'user', content: '请运行代码验证 6 * 7', createdAt: new Date().toISOString() },
        ],
        agentMode: true,
        reasoningEnabled: false,
      },
      (event) => events.push(event),
    )

    expect(fetchCount).toBe(2)
    expect(executeMcp).not.toHaveBeenCalled()
    expect(
      events.some(
        (event) =>
          event.type === 'tool-result' && event.callId === 'call-run-code' && event.result === '42' && !event.isError,
      ),
    ).toBe(true)
    expect(events.some((event) => event.type === 'text-delta' && event.delta.includes('42'))).toBe(true)
  })

  it('executes a command through the configured integrated terminal shell', async () => {
    await repo.updateSettings({
      mcpToolApprovalPolicy: 'full-access',
      integratedTerminalShell: { mode: 'auto', executable: '', args: [] },
    })
    vi.spyOn(mcpManager, 'listAllTools').mockResolvedValue([])
    const executeMcp = vi.spyOn(mcpManager, 'executeTool')
    const command = 'node -p "process.cwd()"'
    let fetchCount = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      fetchCount += 1
      if (fetchCount === 1) {
        return makeSseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-run-terminal', function: { name: 'agentbox_run_terminal', arguments: JSON.stringify({ command }) } }] }, finish_reason: 'tool_calls' }] })}\n\n`,
          'data: [DONE]\n\n',
        ])
      }
      return makeSseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'Terminal command completed.' }, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      ])
    })

    const events: StreamEvent[] = []
    await gateway.stream(
      'req-run-terminal',
      {
        conversationId: 'conversation-run-terminal',
        modelId: repo.listModels().find((item) => item.remoteId === 'test/auto-model')!.id,
        messages: [
          {
            id: 'user-run-terminal',
            role: 'user',
            content: '请通过终端输出 terminal-42',
            createdAt: new Date().toISOString(),
          },
        ],
        workingDirectory: tempDirectory,
        agentMode: true,
        reasoningEnabled: false,
      },
      (event) => events.push(event),
    )

    expect(fetchCount).toBe(2)
    expect(executeMcp).not.toHaveBeenCalled()
    const terminalResult = events.find((event) => event.type === 'tool-result' && event.callId === 'call-run-terminal')
    expect(terminalResult).toBeDefined()
    if (!terminalResult || terminalResult.type !== 'tool-result') throw new Error('Missing terminal result')
    expect(terminalResult.isError).toBe(false)
    const reportedWorkingDirectory = terminalResult.result.trim().split(/\r?\n/).at(-1) || ''
    const comparablePath = (value: string) => {
      const normalizedPath = normalize(value)
      return process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath
    }
    expect(comparablePath(reportedWorkingDirectory)).toBe(comparablePath(realpathSync(tempDirectory)))
  }, 15_000)

  it('writes and reads workspace files without shell escaping', async () => {
    await repo.updateSettings({ mcpToolApprovalPolicy: 'full-access' })
    vi.spyOn(mcpManager, 'listAllTools').mockResolvedValue([])
    const executeMcp = vi.spyOn(mcpManager, 'executeTool')
    const content = 'const template = `value: ${input}`\nconsole.log("你好", template)\n'
    let fetchCount = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      fetchCount += 1
      if (fetchCount === 1) {
        return makeSseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-write-file', function: { name: 'agentbox_write_file', arguments: JSON.stringify({ path: 'generated/example.ts', content, mode: 'overwrite' }) } }] }, finish_reason: 'tool_calls' }] })}\n\n`,
          'data: [DONE]\n\n',
        ])
      }
      if (fetchCount === 2) {
        return makeSseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-read-file', function: { name: 'agentbox_read_file', arguments: JSON.stringify({ path: 'generated/example.ts' }) } }] }, finish_reason: 'tool_calls' }] })}\n\n`,
          'data: [DONE]\n\n',
        ])
      }
      return makeSseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'File created and verified.' }, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      ])
    })

    const events: StreamEvent[] = []
    await gateway.stream(
      'req-workspace-file',
      {
        conversationId: 'conversation-workspace-file',
        modelId: repo.listModels().find((item) => item.remoteId === 'test/auto-model')!.id,
        messages: [
          {
            id: 'user-workspace-file',
            role: 'user',
            content: '请将代码写入 generated/example.ts 并复核',
            createdAt: new Date().toISOString(),
          },
        ],
        workingDirectory: tempDirectory,
        agentMode: true,
        reasoningEnabled: false,
      },
      (event) => events.push(event),
    )

    expect(fetchCount).toBe(3)
    expect(executeMcp).not.toHaveBeenCalled()
    expect(readFileSync(join(tempDirectory, 'generated', 'example.ts'), 'utf8')).toBe(content)
    expect(
      events.some((event) => event.type === 'tool-result' && event.callId === 'call-write-file' && !event.isError),
    ).toBe(true)
    expect(
      events.some(
        (event) =>
          event.type === 'tool-result' &&
          event.callId === 'call-read-file' &&
          event.result.includes('console.log("你好", template)') &&
          !event.isError,
      ),
    ).toBe(true)
  })

  it('replays an interrupted Agent checkpoint when the user continues', async () => {
    vi.spyOn(mcpManager, 'listAllTools').mockResolvedValue([])
    let requestBody = ''
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requestBody = String(init?.body || '')
      return makeSseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'Resumed from the saved checkpoint.' }, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      ])
    })

    const checkpointId = 'assistant-interrupted-checkpoint'
    const events: StreamEvent[] = []
    await gateway.stream(
      'req-resume-checkpoint',
      {
        conversationId: 'conversation-resume-checkpoint',
        modelId: repo.listModels().find((item) => item.remoteId === 'test/auto-model')!.id,
        messages: [
          {
            id: 'user-original',
            role: 'user',
            content: 'Create the project files',
            createdAt: new Date().toISOString(),
          },
          {
            id: checkpointId,
            role: 'assistant',
            content: 'Created the first file.',
            agentTrace: [
              {
                type: 'tool_call',
                turn: 1,
                callId: 'write-one',
                toolName: 'write_file',
                modelToolName: 'agentbox_write_file',
                args: { path: 'one.ts', content: 'export {}' },
              },
              { type: 'tool_result', turn: 1, callId: 'write-one', toolName: 'write_file', result: 'file written' },
            ],
            interruption: { reason: 'network', message: 'network disconnected', occurredAt: new Date().toISOString() },
            createdAt: new Date().toISOString(),
          },
          { id: 'user-resume', role: 'user', content: '继续', createdAt: new Date().toISOString() },
        ],
        workingDirectory: tempDirectory,
        resumeFromMessageId: checkpointId,
        agentMode: true,
        reasoningEnabled: false,
      },
      (event) => events.push(event),
    )

    expect(requestBody).toContain('从中断现场继续')
    expect(requestBody).toContain('file written')
    expect(requestBody).toContain('不要从头重复整个任务')
    expect(events.some((event) => event.type === 'text-delta' && event.delta.includes('saved checkpoint'))).toBe(true)
  })

  it('resumes a provider failure from the encrypted LangGraph checkpoint and removes it after success', async () => {
    vi.spyOn(mcpManager, 'listAllTools').mockResolvedValue([])
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('fetch failed before the model turn completed'))
      .mockImplementationOnce(async () =>
        makeSseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'Recovered durably.' }, finish_reason: 'stop' }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      )
    const conversationId = 'conversation-durable-resume'
    const responseMessageId = 'assistant-durable-resume'
    const modelId = repo.listModels().find((item) => item.remoteId === 'test/auto-model')!.id
    const originalMessages: ChatRequest['messages'] = [
      {
        id: 'user-durable-original',
        role: 'user',
        content: 'Continue this request after a network failure.',
        createdAt: new Date().toISOString(),
      },
    ]
    const firstEvents: StreamEvent[] = []
    await gateway.stream(
      'req-durable-first',
      {
        conversationId,
        responseMessageId,
        modelId,
        messages: originalMessages,
        workingDirectory: tempDirectory,
        agentMode: true,
        reasoningEnabled: false,
      },
      (event) => firstEvents.push(event),
    )
    expect(firstEvents.some((event) => event.type === 'error')).toBe(true)
    const threadId = agentCheckpointThreadId(conversationId, responseMessageId)
    await expect(repo.getAgentCheckpointSaver().getThreadDescriptor(threadId)).resolves.toMatchObject({
      lifecycle: 'interrupted',
      responseMessageId,
    })

    const resumedEvents: StreamEvent[] = []
    await gateway.stream(
      'req-durable-second',
      {
        conversationId,
        responseMessageId: 'assistant-durable-follow-up',
        modelId,
        messages: [
          ...originalMessages,
          {
            id: responseMessageId,
            role: 'assistant',
            content: '',
            interruption: {
              reason: 'network',
              message: 'fetch failed before the model turn completed',
              occurredAt: new Date().toISOString(),
            },
            createdAt: new Date().toISOString(),
          },
          { id: 'user-durable-resume', role: 'user', content: '继续', createdAt: new Date().toISOString() },
        ],
        workingDirectory: tempDirectory,
        resumeFromMessageId: responseMessageId,
        agentMode: true,
        reasoningEnabled: false,
      },
      (event) => resumedEvents.push(event),
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(resumedEvents.some((event) => event.type === 'text-delta' && event.delta === 'Recovered durably.')).toBe(
      true,
    )
    await expect(repo.getAgentCheckpointSaver().getThreadDescriptor(threadId)).resolves.toBeUndefined()
  })

  it('rejects a stale checkpoint digest and falls back to the validated agentTrace path', async () => {
    vi.spyOn(mcpManager, 'listAllTools').mockResolvedValue([])
    let resumedBody = ''
    vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementationOnce(async (_input, init) => {
        resumedBody = String(init?.body || '')
        return makeSseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'Recovered through trace fallback.' }, finish_reason: 'stop' }] })}\n\n`,
          'data: [DONE]\n\n',
        ])
      })
    const conversationId = 'conversation-stale-checkpoint'
    const interruptedId = 'assistant-stale-checkpoint'
    const followUpId = 'assistant-stale-follow-up'
    const modelId = repo.listModels().find((item) => item.remoteId === 'test/auto-model')!.id
    await gateway.stream(
      'req-stale-first',
      {
        conversationId,
        responseMessageId: interruptedId,
        modelId,
        messages: [
          {
            id: 'user-stale-original',
            role: 'user',
            content: 'Original request before editing.',
            createdAt: new Date().toISOString(),
          },
        ],
        agentMode: true,
        reasoningEnabled: false,
      },
      () => undefined,
    )
    const staleThreadId = agentCheckpointThreadId(conversationId, interruptedId)
    await expect(repo.getAgentCheckpointSaver().getThreadDescriptor(staleThreadId)).resolves.toBeDefined()

    await gateway.stream(
      'req-stale-second',
      {
        conversationId,
        responseMessageId: followUpId,
        modelId,
        messages: [
          {
            id: 'user-stale-original',
            role: 'user',
            content: 'Edited request invalidates the old digest.',
            createdAt: new Date().toISOString(),
          },
          {
            id: interruptedId,
            role: 'assistant',
            content: 'partial',
            agentTrace: [{ type: 'assistant_text', turn: 1, text: 'partial' }],
            interruption: { reason: 'network', message: 'fetch failed', occurredAt: new Date().toISOString() },
            createdAt: new Date().toISOString(),
          },
          { id: 'user-stale-resume', role: 'user', content: '继续', createdAt: new Date().toISOString() },
        ],
        resumeFromMessageId: interruptedId,
        agentMode: true,
        reasoningEnabled: false,
      },
      () => undefined,
    )

    expect(resumedBody).toContain('Edited request invalidates the old digest.')
    expect(resumedBody).toContain('从中断现场继续')
    await expect(repo.getAgentCheckpointSaver().getThreadDescriptor(staleThreadId)).resolves.toBeDefined()
    await expect(
      repo.getAgentCheckpointSaver().getThreadDescriptor(agentCheckpointThreadId(conversationId, followUpId)),
    ).resolves.toBeUndefined()
  })

  it('waits for explicit approval before executing a sensitive tool', async () => {
    vi.useFakeTimers()
    await repo.updateSettings({ mcpToolApprovalPolicy: 'always' })
    vi.spyOn(mcpManager, 'listAllTools').mockResolvedValue([
      {
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
      },
    ])
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
    const stream = gateway.stream(
      'req-approval',
      {
        conversationId: 'conversation-approval',
        modelId: repo.listModels().find((item) => item.remoteId === 'test/auto-model')!.id,
        messages: [
          {
            id: 'user-approval',
            role: 'user',
            content: 'Use send_email to contact a@example.com',
            createdAt: new Date().toISOString(),
          },
        ],
        agentMode: true,
        reasoningEnabled: false,
      },
      (event) => {
        events.push(event)
        if (event.type === 'tool-approval-required') resolveApproval(event)
      },
    )

    const approvalEvent = await approval
    expect(execute).not.toHaveBeenCalled()
    expect(approvalEvent.args).toEqual({ to: 'a@example.com' })
    await vi.advanceTimersByTimeAsync(121_000)
    expect(execute).not.toHaveBeenCalled()
    expect(events.some((event) => event.type === 'done' || event.type === 'error')).toBe(false)
    gateway.resolveToolApproval('req-approval', 'call-mail', true)
    await stream
    expect(execute).toHaveBeenCalledTimes(1)
    expect(events.some((event) => event.type === 'done')).toBe(true)
    await repo.updateSettings({ mcpToolApprovalPolicy: 'full-access' })
  })

  it('can wait for tool approval indefinitely until the user decides', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const waitForToolApproval = (
      gateway as unknown as {
        waitForToolApproval: (
          requestId: string,
          callId: string,
          signal: AbortSignal,
          timeoutMode: 'five-minutes' | 'never',
        ) => Promise<boolean>
      }
    ).waitForToolApproval.bind(gateway)
    let settled = false
    const waiting = waitForToolApproval('req-no-timeout', 'call-no-timeout', controller.signal, 'never').then(
      (approved) => {
        settled = true
        return approved
      },
    )

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000)
    expect(settled).toBe(false)
    gateway.resolveToolApproval('req-no-timeout', 'call-no-timeout', true)
    await expect(waiting).resolves.toBe(true)
  })

  it('executes at most thirty tool turns by default and always emits a terminal event', async () => {
    await repo.updateSettings({ mcpToolApprovalPolicy: 'full-access' })
    vi.spyOn(mcpManager, 'listAllTools').mockResolvedValue([
      {
        name: 'loop_tool',
        modelName: 'mcp_loop_tool',
        description: 'Loop tool',
        inputSchema: { type: 'object', properties: {} },
        serverId: 'loop-server',
        serverName: 'Loop',
      },
    ])
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
    await gateway.stream(
      'req-loop-limit',
      {
        conversationId: 'conversation-loop-limit',
        modelId: repo.listModels().find((item) => item.remoteId === 'test/auto-model')!.id,
        messages: [
          { id: 'user-loop', role: 'user', content: 'Use loop_tool repeatedly', createdAt: new Date().toISOString() },
        ],
        agentMode: true,
        reasoningEnabled: false,
      },
      (event) => events.push(event),
    )

    expect(fetchCount).toBe(31)
    expect(execute).toHaveBeenCalledTimes(30)
    expect(events.some((event) => event.type === 'done' && event.finishReason === 'tool_turn_limit')).toBe(true)
  })

  it('respects a user-configured Agent tool turn limit', async () => {
    await repo.updateSettings({ agentToolTurnLimit: 2, mcpToolApprovalPolicy: 'full-access' })
    vi.spyOn(mcpManager, 'listAllTools').mockResolvedValue([
      {
        name: 'configured_loop_tool',
        modelName: 'mcp_configured_loop_tool',
        description: 'Configured loop tool',
        inputSchema: { type: 'object', properties: {} },
        serverId: 'configured-loop-server',
        serverName: 'Configured Loop',
      },
    ])
    const execute = vi.spyOn(mcpManager, 'executeTool').mockResolvedValue({
      result: 'continue',
      isError: false,
      serverName: 'Configured Loop',
    })
    let fetchCount = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      fetchCount += 1
      return makeSseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call-configured-${fetchCount}`, function: { name: 'mcp_configured_loop_tool', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`,
        'data: [DONE]\n\n',
      ])
    })

    const events: StreamEvent[] = []
    await gateway.stream(
      'req-configured-loop-limit',
      {
        conversationId: 'conversation-configured-loop-limit',
        modelId: repo.listModels().find((item) => item.remoteId === 'test/auto-model')!.id,
        messages: [
          {
            id: 'user-configured-loop',
            role: 'user',
            content: 'Use configured_loop_tool repeatedly',
            createdAt: new Date().toISOString(),
          },
        ],
        agentMode: true,
        reasoningEnabled: false,
      },
      (event) => events.push(event),
    )

    expect(fetchCount).toBe(3)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(events.some((event) => event.type === 'done' && event.finishReason === 'tool_turn_limit')).toBe(true)
    await repo.updateSettings({ agentToolTurnLimit: 30 })
  })
})
