import type { StreamEvent } from '../../shared/types'

/**
 * Executes a stream request and guarantees that no stream events are lost,
 * even if they are emitted asynchronously before the stream promise resolves
 * with the `requestId`.
 * 
 * It achieves this by registering the event listener immediately, buffering
 * all events until the `requestId` is known, and then synchronously replaying
 * the matched events.
 * 
 * @param streamApi The function to initiate the stream, returning `{ requestId }`.
 * @param onEventApi The function to subscribe to stream events, returning an unsubscribe function.
 * @param processEvent The callback to process a matched stream event.
 * @returns A promise that resolves to the unsubscribe function.
 */
export async function runStreamWithReplay<TRequest>(
  streamApi: (request: TRequest) => Promise<{ requestId: string }>,
  onEventApi: (listener: (event: StreamEvent) => void) => () => void,
  request: TRequest,
  processEvent: (event: StreamEvent) => void
): Promise<{ unsubscribe: () => void; requestId: string }> {
  let activeRequestId: string | undefined
  const eventQueue: StreamEvent[] = []

  const unsubscribe = onEventApi((event) => {
    if (activeRequestId) {
      if (event.requestId === activeRequestId) {
        processEvent(event)
      }
    } else {
      // Buffer events received before the stream invocation resolves.
      eventQueue.push(event)
    }
  })

  try {
    const { requestId } = await streamApi(request)
    activeRequestId = requestId

    // Replay any buffered events that belong to this stream.
    for (const event of eventQueue) {
      if (event.requestId === activeRequestId) {
        processEvent(event)
      }
    }
    eventQueue.length = 0

    return { unsubscribe, requestId }
  } catch (error) {
    unsubscribe()
    throw error
  }
}
