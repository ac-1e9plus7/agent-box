import type { StreamEvent } from '../../shared/types'

/** Batch high-frequency deltas; state transitions flush synchronously in event order. */
export function createStreamEventBatcher(deliver: (events: StreamEvent[]) => void) {
  let events: StreamEvent[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    if (!events.length) return
    const pending = events
    events = []
    deliver(pending)
  }
  return {
    flush,
    push(event: StreamEvent) {
      const last = events.at(-1)
      if (
        event.type === 'text-delta' &&
        last?.type === 'text-delta' &&
        event.turn === last.turn &&
        event.requestId === last.requestId
      ) {
        events[events.length - 1] = { ...last, delta: last.delta + event.delta }
      } else events.push(event)
      if (event.type !== 'text-delta' && event.type !== 'reasoning-delta') flush()
      else timer ??= setTimeout(flush, 16)
    },
    dispose: () => {
      clearTimeout(timer)
      timer = undefined
      events = []
    },
  }
}
