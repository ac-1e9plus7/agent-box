import { describe, expect, it, vi } from 'vitest'
import { runStreamWithReplay } from '../src/renderer/src/stream-helper'
import type { StreamEvent } from '../src/shared/types'

describe('runStreamWithReplay', () => {
  it('processes events that arrive after the promise resolves normally', async () => {
    let mockListener: ((event: StreamEvent) => void) | undefined
    const mockOnEventApi = vi.fn((listener) => {
      mockListener = listener
      return vi.fn()
    })
    const mockStreamApi = vi.fn(async () => ({ requestId: 'req-1' }))
    const mockProcessEvent = vi.fn()

    const { unsubscribe, requestId } = await runStreamWithReplay(
      mockStreamApi,
      mockOnEventApi,
      { prompt: 'test' },
      mockProcessEvent
    )

    expect(requestId).toBe('req-1')
    expect(mockOnEventApi).toHaveBeenCalledOnce()

    // Emit event after resolution
    mockListener?.({ type: 'text-delta', requestId: 'req-1', delta: 'hello' })
    mockListener?.({ type: 'text-delta', requestId: 'req-2', delta: 'ignored' })

    expect(mockProcessEvent).toHaveBeenCalledTimes(1)
    expect(mockProcessEvent).toHaveBeenCalledWith({ type: 'text-delta', requestId: 'req-1', delta: 'hello' })

    unsubscribe()
  })

  it('buffers and replays events that arrive synchronously before the stream promise resolves', async () => {
    let mockListener: ((event: StreamEvent) => void) | undefined
    const mockOnEventApi = vi.fn((listener) => {
      mockListener = listener
      return vi.fn()
    })

    const mockStreamApi = vi.fn(async () => {
      // Simulate an IPC environment where the event is emitted immediately,
      // BEFORE the microtask queue resolves this streamApi promise for the caller.
      mockListener?.({ type: 'start', requestId: 'req-race' })
      mockListener?.({ type: 'text-delta', requestId: 'req-race', delta: 'fast' })
      mockListener?.({ type: 'done', requestId: 'req-race' })
      
      // Also emit an unrelated event to ensure it gets ignored
      mockListener?.({ type: 'text-delta', requestId: 'req-other', delta: 'ignored' })

      return { requestId: 'req-race' }
    })
    const mockProcessEvent = vi.fn()

    await runStreamWithReplay(
      mockStreamApi,
      mockOnEventApi,
      { prompt: 'test' },
      mockProcessEvent
    )

    // The events were buffered and replayed successfully upon resolution
    expect(mockProcessEvent).toHaveBeenCalledTimes(3)
    expect(mockProcessEvent).toHaveBeenNthCalledWith(1, { type: 'start', requestId: 'req-race' })
    expect(mockProcessEvent).toHaveBeenNthCalledWith(2, { type: 'text-delta', requestId: 'req-race', delta: 'fast' })
    expect(mockProcessEvent).toHaveBeenNthCalledWith(3, { type: 'done', requestId: 'req-race' })
  })

  it('unsubscribes and propagates the error if the stream API throws', async () => {
    const mockUnsubscribe = vi.fn()
    const mockOnEventApi = vi.fn(() => mockUnsubscribe)
    const mockStreamApi = vi.fn(async () => {
      throw new Error('Network failure')
    })
    const mockProcessEvent = vi.fn()

    await expect(
      runStreamWithReplay(mockStreamApi, mockOnEventApi, { prompt: 'test' }, mockProcessEvent)
    ).rejects.toThrow('Network failure')

    expect(mockUnsubscribe).toHaveBeenCalledOnce()
    expect(mockProcessEvent).not.toHaveBeenCalled()
  })
})
