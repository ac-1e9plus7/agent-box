// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useConversationTitles } from '../src/renderer/src/hooks/useConversationTitles'
import { toUiConversation } from '../src/renderer/src/hooks/useConversation'
import { createRendererApiMock, rendererConversation, rendererModel } from './renderer-test-fixtures'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function setup() {
  const bridge = createRendererApiMock()
  Object.defineProperty(window, 'agentbox', { configurable: true, value: bridge.api })
  const conversationsRef = { current: [toUiConversation(rendererConversation)] }
  const save = vi.fn(async () => true)
  const hook = renderHook(() =>
    useConversationTitles({
      conversationsRef,
      models: [rendererModel],
      persistConversation: save,
      replaceConversations: (update) => (conversationsRef.current = update(conversationsRef.current)),
    }),
  )
  return { bridge, conversationsRef, save, hook }
}

it('finishes and unsubscribes when title events arrive before the IPC response', async () => {
  const s = setup()
  s.bridge.mocks.stream.mockImplementationOnce(async () => {
    s.bridge.emit({ type: 'text-delta', requestId: 'title-id', delta: 'New title' })
    s.bridge.emit({ type: 'done', requestId: 'title-id' })
    return { requestId: 'title-id' }
  })
  await act(() => s.hook.result.current.maybeGenerateTitle(s.conversationsRef.current[0]!))
  expect(s.conversationsRef.current[0]?.title).toBe('New title')
  s.bridge.emit({ type: 'done', requestId: 'title-id' })
  expect(s.save).toHaveBeenCalledOnce()
})

it('cancels a request whose ID arrives after the title deadline', async () => {
  vi.useFakeTimers()
  const s = setup()
  let resolve!: (value: { requestId: string }) => void
  s.bridge.mocks.stream.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const pending = s.hook.result.current.maybeGenerateTitle(s.conversationsRef.current[0]!)
  vi.advanceTimersByTime(20_000)
  resolve({ requestId: 'late-title' })
  await pending
  expect(s.bridge.mocks.cancel).toHaveBeenCalledWith('late-title')
  expect(s.save).not.toHaveBeenCalled()
})

it('preserves manual renaming and closes a superseded title request', async () => {
  const s = setup()
  await s.hook.result.current.maybeGenerateTitle(s.conversationsRef.current[0]!)
  s.hook.result.current.renameConversation(rendererConversation.id, 'Manual')
  s.bridge.emit({ type: 'text-delta', requestId: 'request-1', delta: 'Automatic' })
  s.bridge.emit({ type: 'done', requestId: 'request-1' })
  expect(s.conversationsRef.current[0]?.title).toBe('Manual')
  expect(s.bridge.mocks.cancel).toHaveBeenCalledWith('request-1')
})
