// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useChatStream } from '../src/renderer/src/hooks/useChatStream'
import { createRendererApiMock, rendererConversation } from './renderer-test-fixtures'
import { toUiConversation } from '../src/renderer/src/hooks/useConversation'
import type { ChatRequest, StreamEvent } from '../src/shared/types'
import { createStreamEventBatcher } from '../src/renderer/src/stream-event-batcher'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function setup() {
  const bridge = createRendererApiMock()
  Object.defineProperty(window, 'agentbox', { configurable: true, value: bridge.api })
  let conversations = ['a', 'b'].map((id) =>
    toUiConversation({
      ...rendererConversation,
      id,
      messages: [{ id: `${id}-assistant`, role: 'assistant', content: '', createdAt: new Date().toISOString() }],
    }),
  )
  const persist = vi.fn(async () => true)
  const titles = vi.fn()
  const hook = renderHook(() =>
    useChatStream({
      maybeGenerateTitle: titles,
      persistConversation: persist,
      showToast: vi.fn(),
      replaceConversations: (update) => (conversations = update(conversations)),
    }),
  )
  const registration = (id: string) => ({ conversationId: id, assistantMessageId: `${id}-assistant`, agentMode: false })
  const request = (id: string): ChatRequest => ({
    conversationId: id,
    modelId: 'model-1',
    messages: [],
    reasoningEnabled: false,
  })
  return { bridge, hook, registration, request, persist, titles, conversations: () => conversations }
}

describe('chat stream correlation and lifecycle', () => {
  it('persists normalized reasoning, approval, citations, usage and tool history in event order', async () => {
    const s = setup()
    act(() => s.hook.result.current.prepareStream({ ...s.registration('a'), agentMode: true }))
    await act(() => s.hook.result.current.launchPreparedStream(s.registration('a'), s.request('a')))
    const requestId = 'request-1'
    const approval = {
      type: 'tool-approval-required',
      requestId,
      callId: 'call',
      toolName: 'tool',
      modelToolName: 'model-tool',
      serverName: 'server',
      args: { value: 1 },
      riskLevel: 'sensitive',
      reason: 'Review',
      turn: 1,
    } as const
    const events: StreamEvent[] = [
      { type: 'data-plat-context', requestId },
      { type: 'skill-activated', requestId, skill: { id: 'skill', name: 'Skill', source: 'model', turn: 1 } },
      { type: 'skill-activated', requestId, skill: { id: 'skill', name: 'Skill', source: 'model', turn: 2 } },
      { type: 'reasoning-delta', requestId, delta: 'Think', thinkingBlockIndex: 0, signatureDelta: 's', turn: 1 },
      { type: 'reasoning-delta', requestId, delta: ' more', thinkingBlockIndex: 0, signatureDelta: 'ig', turn: 1 },
      {
        type: 'agent-provider-item',
        requestId,
        turn: 1,
        format: 'openai-responses',
        item: { id: 'item', type: 'reasoning' },
      },
      {
        type: 'agent-provider-item',
        requestId,
        turn: 1,
        format: 'openai-responses',
        item: { id: 'item', type: 'reasoning', summary: [] },
      },
      {
        type: 'provider-continuation',
        requestId,
        continuation: { format: 'openai-responses', responseId: 'resp_fixture', turn: 1 },
      },
      { type: 'tool-call-start', requestId, callId: 'call', toolName: 'tool', turn: 1 },
      { type: 'tool-call-start', requestId, callId: 'call', toolName: 'tool', turn: 1 },
      approval,
      approval,
      { type: 'tool-call-complete', requestId, callId: 'call', toolName: 'tool', args: { value: 1 }, turn: 1 },
      {
        type: 'tool-result',
        requestId,
        callId: 'call',
        toolName: 'tool',
        result: 'Result',
        structuredResult: { value: 2 },
        turn: 1,
      },
      { type: 'citation', requestId, citation: { url: 'https://example.test/' } },
      { type: 'citation', requestId, citation: { url: 'https://example.test/', title: 'Enriched' } },
      { type: 'usage', requestId, turn: 1, usage: { inputTokens: 10 } },
      { type: 'usage', requestId, turn: 1, usage: { outputTokens: 2 } },
      { type: 'text-delta', requestId, delta: 'Answer', turn: 1 },
      { type: 'done', requestId },
    ]
    act(() => events.forEach(s.bridge.emit))
    const message = s.conversations()[0]?.messages[0]
    expect(message).toMatchObject({
      governedData: true,
      content: 'Answer',
      reasoning: 'Think more',
      status: 'complete',
      usage: { inputTokens: 10, outputTokens: 2 },
      citations: [{ url: 'https://example.test/', title: 'Enriched' }],
    })
    expect(message?.toolExecutions).toHaveLength(1)
    expect(message?.toolExecutions?.[0]).toMatchObject({ status: 'complete', result: 'Result' })
    expect(message?.agentTrace).toEqual(
      expect.arrayContaining([
        { type: 'assistant_thinking', turn: 1, blockIndex: 0, thinking: 'Think more', signature: 'sig' },
      ]),
    )
    expect(s.persist).toHaveBeenCalledOnce()
  })

  it('checkpoints a pending approval when generation is stopped', async () => {
    const s = setup()
    act(() => s.hook.result.current.prepareStream({ ...s.registration('a'), agentMode: true }))
    await act(() => s.hook.result.current.launchPreparedStream(s.registration('a'), s.request('a')))
    act(() =>
      s.bridge.emit({
        type: 'tool-approval-required',
        requestId: 'request-1',
        callId: 'pending',
        toolName: 'tool',
        modelToolName: 'model-tool',
        args: {},
        riskLevel: 'sensitive',
        reason: 'Review',
        turn: 1,
      }),
    )
    await act(() => s.hook.result.current.resolveToolApproval('a', 'pending', { decision: 'deny' }))
    await act(() => s.hook.result.current.stopStream('a'))
    const message = s.conversations()[0]?.messages[0]
    expect(message?.interruption?.reason).toBe('cancelled')
    expect(message?.toolExecutions?.[0]?.status).toBe('error')
    expect(
      message?.agentTrace?.some((item) => item.type === 'tool_result' && item.callId === 'pending' && item.isError),
    ).toBe(true)
  })
  it('ignores title events while a prepared conversation is waiting for persistence', () => {
    const s = setup()
    act(() => s.hook.result.current.prepareStream(s.registration('a')))
    act(() => {
      s.bridge.emit({ type: 'start', requestId: 'title' })
      s.bridge.emit({ type: 'text-delta', requestId: 'title', delta: 'wrong' })
      s.bridge.emit({ type: 'done', requestId: 'title' })
    })
    expect(s.conversations()[0]?.messages[0]?.content).toBe('')
    expect(s.persist).not.toHaveBeenCalled()
  })

  it('routes two interleaved early streams by the returned request IDs', async () => {
    const s = setup()
    let first!: (id: { requestId: string }) => void
    let second!: (id: { requestId: string }) => void
    s.bridge.mocks.stream
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            first = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            second = resolve
          }),
      )
    act(() => {
      s.hook.result.current.prepareStream(s.registration('a'))
      s.hook.result.current.prepareStream(s.registration('b'))
    })
    let a!: Promise<boolean>
    let b!: Promise<boolean>
    await act(async () => {
      a = s.hook.result.current.launchPreparedStream(s.registration('a'), s.request('a'))
      b = s.hook.result.current.launchPreparedStream(s.registration('b'), s.request('b'))
      s.bridge.emit({ type: 'start', requestId: 'b-id' })
      s.bridge.emit({ type: 'text-delta', requestId: 'b-id', delta: 'B' })
      s.bridge.emit({ type: 'text-delta', requestId: 'title', delta: 'ignore' })
      s.bridge.emit({ type: 'start', requestId: 'a-id' })
      s.bridge.emit({ type: 'text-delta', requestId: 'a-id', delta: 'A' })
      s.bridge.emit({ type: 'done', requestId: 'b-id' })
      s.bridge.emit({ type: 'done', requestId: 'a-id' })
      second({ requestId: 'b-id' })
      first({ requestId: 'a-id' })
      await Promise.all([a, b])
    })
    expect(s.conversations().map((c) => c.messages[0]?.content)).toEqual(['A', 'B'])
    expect(s.persist).toHaveBeenCalledTimes(2)
    expect(s.hook.result.current.streamingConversationIds.size).toBe(0)
  })

  it.each(['cancel', 'stop', 'unmount'] as const)('cancels a late IPC request after %s', async (action) => {
    const s = setup()
    let resolve!: (id: { requestId: string }) => void
    s.bridge.mocks.stream.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    act(() => s.hook.result.current.prepareStream(s.registration('a')))
    let started!: Promise<boolean>
    await act(async () => {
      started = s.hook.result.current.launchPreparedStream(s.registration('a'), s.request('a'))
      if (action === 'cancel') await s.hook.result.current.cancelConversationStream('a')
      else if (action === 'stop') await s.hook.result.current.stopStream('a')
      else s.hook.unmount()
      resolve({ requestId: 'late-id' })
      await started
    })
    expect(s.bridge.mocks.cancel).toHaveBeenCalledWith('late-id')
    expect(s.conversations()[0]?.messages[0]?.content).toBe('')
  })

  it('does not start a paid request after a prepared stream was discarded', async () => {
    const s = setup()
    act(() => {
      s.hook.result.current.prepareStream(s.registration('a'))
      s.hook.result.current.discardStream('a')
    })
    expect(await s.hook.result.current.launchPreparedStream(s.registration('a'), s.request('a'))).toBe(false)
    expect(s.bridge.mocks.stream).not.toHaveBeenCalled()
  })

  it('merges deltas within one frame and flushes before ordered state transitions', () => {
    vi.useFakeTimers()
    const delivered = vi.fn()
    const batch = createStreamEventBatcher(delivered)
    for (let i = 0; i < 100; i++) batch.push({ type: 'text-delta', requestId: 'a', delta: 'x' })
    expect(delivered).not.toHaveBeenCalled()
    vi.advanceTimersByTime(16)
    expect(delivered).toHaveBeenCalledTimes(1)
    expect(delivered.mock.calls[0]?.[0]).toEqual([{ type: 'text-delta', requestId: 'a', delta: 'x'.repeat(100) }])
    batch.push({ type: 'text-delta', requestId: 'a', delta: 'last' })
    batch.push({ type: 'done', requestId: 'a' })
    expect(delivered.mock.calls[1]?.[0].map((e: { type: string }) => e.type)).toEqual(['text-delta', 'done'])
    batch.dispose()
  })
})
