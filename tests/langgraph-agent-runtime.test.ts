import { describe, expect, it, vi } from 'vitest'
import type { Message } from '../src/shared/types'
import { runAgentRuntime, type AgentModelTurnResult } from '../src/electron/api/agent-runtime'

interface TestToolCall {
  id: string
}

type TestModelResult = AgentModelTurnResult<TestToolCall> & { label: string }

const initialMessages: Message[] = [
  { id: 'user-1', role: 'user', content: 'Run the task', createdAt: '2026-01-01T00:00:00.000Z' },
]

function result(label: string, toolCalls: TestToolCall[] = []): TestModelResult {
  return { label, toolCalls }
}

describe('LangGraph Agent runtime', () => {
  it('completes after one model turn when no tool is requested', async () => {
    const onComplete = vi.fn()
    const runtimeResult = await runAgentRuntime({
      initialMessages,
      agentMode: true,
      maxToolTurns: 3,
      invokeModel: vi.fn(async () => result('done')),
      executeTools: vi.fn(async () => initialMessages),
      onComplete,
      onUnexpectedToolCall: vi.fn(),
      onToolTurnLimit: vi.fn(),
    })

    expect(runtimeResult).toMatchObject({ turn: 1, toolTurns: 0, terminalReason: 'complete' })
    expect(onComplete).toHaveBeenCalledOnce()
  })

  it('runs repeated model and tool nodes while counting a multi-call response as one tool turn', async () => {
    const modelResults = [
      result('first', [{ id: 'call-1' }, { id: 'call-2' }]),
      result('second', [{ id: 'call-3' }]),
      result('done'),
    ]
    const invokeModel = vi.fn(async () => modelResults.shift()!)
    const executeTools = vi.fn(async ({ messages, toolTurns }) => [
      ...messages,
      {
        id: `assistant-${toolTurns}`,
        role: 'assistant' as const,
        content: `tool-turn-${toolTurns}`,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ])

    const runtimeResult = await runAgentRuntime({
      initialMessages,
      agentMode: true,
      maxToolTurns: 3,
      invokeModel,
      executeTools,
      onComplete: vi.fn(),
      onUnexpectedToolCall: vi.fn(),
      onToolTurnLimit: vi.fn(),
    })

    expect(runtimeResult).toMatchObject({ turn: 3, toolTurns: 2, terminalReason: 'complete' })
    expect(runtimeResult.messages).toHaveLength(3)
    expect(executeTools).toHaveBeenCalledTimes(2)
    expect(executeTools.mock.calls[0]?.[0]).toMatchObject({ turn: 1, toolTurns: 1 })
    expect(executeTools.mock.calls[1]?.[0]).toMatchObject({ turn: 2, toolTurns: 2 })
  })

  it('routes unexecuted calls to the tool-turn limit handler', async () => {
    const onToolTurnLimit = vi.fn()
    const executeTools = vi.fn(async ({ messages }) => messages)
    const modelResults = [result('first', [{ id: 'call-1' }]), result('limited', [{ id: 'call-2' }])]

    const runtimeResult = await runAgentRuntime({
      initialMessages,
      agentMode: true,
      maxToolTurns: 1,
      invokeModel: vi.fn(async () => modelResults.shift()!),
      executeTools,
      onComplete: vi.fn(),
      onUnexpectedToolCall: vi.fn(),
      onToolTurnLimit,
    })

    expect(runtimeResult).toMatchObject({ turn: 2, toolTurns: 1, terminalReason: 'tool_turn_limit' })
    expect(executeTools).toHaveBeenCalledOnce()
    expect(onToolTurnLimit).toHaveBeenCalledOnce()
    expect(onToolTurnLimit.mock.calls[0]?.[0].modelResult.toolCalls).toEqual([{ id: 'call-2' }])
  })

  it('never executes tools outside Agent mode', async () => {
    const executeTools = vi.fn(async ({ messages }) => messages)
    const onUnexpectedToolCall = vi.fn()

    const runtimeResult = await runAgentRuntime({
      initialMessages,
      agentMode: false,
      maxToolTurns: 3,
      invokeModel: vi.fn(async () => result('unexpected', [{ id: 'call-1' }])),
      executeTools,
      onComplete: vi.fn(),
      onUnexpectedToolCall,
      onToolTurnLimit: vi.fn(),
    })

    expect(runtimeResult.terminalReason).toBe('unexpected_tool_call')
    expect(executeTools).not.toHaveBeenCalled()
    expect(onUnexpectedToolCall).toHaveBeenCalledOnce()
  })

  it('propagates model callback failures without running a terminal handler', async () => {
    const onComplete = vi.fn()
    await expect(
      runAgentRuntime({
        initialMessages,
        agentMode: true,
        maxToolTurns: 3,
        invokeModel: vi.fn(async () => {
          throw new Error('provider failed')
        }),
        executeTools: vi.fn(async () => initialMessages),
        onComplete,
        onUnexpectedToolCall: vi.fn(),
        onToolTurnLimit: vi.fn(),
      }),
    ).rejects.toThrow('provider failed')
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('propagates request cancellation into a running model hook', async () => {
    const controller = new AbortController()
    const pending = runAgentRuntime({
      initialMessages,
      agentMode: true,
      maxToolTurns: 3,
      signal: controller.signal,
      invokeModel: ({ signal }) =>
        new Promise<TestModelResult>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(signal.reason instanceof Error ? signal.reason : new DOMException('cancelled', 'AbortError')),
            { once: true },
          )
        }),
      executeTools: vi.fn(async () => initialMessages),
      onComplete: vi.fn(),
      onUnexpectedToolCall: vi.fn(),
      onToolTurnLimit: vi.fn(),
    })

    controller.abort(new DOMException('cancelled', 'AbortError'))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('disables ambient LangSmith tracing for private Agent state', async () => {
    const previousTracing = process.env.LANGSMITH_TRACING
    const previousLegacyTracing = process.env.LANGCHAIN_TRACING_V2
    process.env.LANGSMITH_TRACING = 'true'
    process.env.LANGCHAIN_TRACING_V2 = 'true'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('remote tracing must stay disabled'))
    try {
      await runAgentRuntime({
        initialMessages,
        agentMode: true,
        maxToolTurns: 3,
        invokeModel: vi.fn(async () => result('done')),
        executeTools: vi.fn(async () => initialMessages),
        onComplete: vi.fn(),
        onUnexpectedToolCall: vi.fn(),
        onToolTurnLimit: vi.fn(),
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      if (previousTracing === undefined) delete process.env.LANGSMITH_TRACING
      else process.env.LANGSMITH_TRACING = previousTracing
      if (previousLegacyTracing === undefined) delete process.env.LANGCHAIN_TRACING_V2
      else process.env.LANGCHAIN_TRACING_V2 = previousLegacyTracing
      fetchSpy.mockRestore()
    }
  })
})
