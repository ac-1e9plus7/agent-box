import { describe, expect, it } from 'vitest'
import { parseSse } from '../src/electron/api/sse'

function createChunkStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
}

async function collectEvents(stream: ReadableStream<Uint8Array>) {
  const events = []
  for await (const message of parseSse(stream)) {
    events.push(message)
  }
  return events
}

describe('SSE stream parser (parseSse)', () => {
  it('parses a basic SSE data event', async () => {
    const stream = createChunkStream(['data: hello world\n\n'])
    const events = await collectEvents(stream)
    expect(events).toEqual([{ event: undefined, data: 'hello world' }])
  })

  it('parses events with event names', async () => {
    const stream = createChunkStream(['event: custom_event\ndata: {"status":"ok"}\n\n'])
    const events = await collectEvents(stream)
    expect(events).toEqual([{ event: 'custom_event', data: '{"status":"ok"}' }])
  })

  it('joins multi-line data fields with newline', async () => {
    const stream = createChunkStream(['data: line 1\ndata: line 2\ndata: line 3\n\n'])
    const events = await collectEvents(stream)
    expect(events).toEqual([{ event: undefined, data: 'line 1\nline 2\nline 3' }])
  })

  it('handles CRLF line endings', async () => {
    const stream = createChunkStream(['event: message\r\ndata: line\r\n\r\n'])
    const events = await collectEvents(stream)
    expect(events).toEqual([{ event: 'message', data: 'line' }])
  })

  it('ignores comment lines starting with colon', async () => {
    const stream = createChunkStream([': keepalive\n\n', ': ping\ndata: real data\n: comment\n\n'])
    const events = await collectEvents(stream)
    expect(events).toEqual([{ event: undefined, data: 'real data' }])
  })

  it('handles field values with or without leading space after colon', async () => {
    const stream = createChunkStream(['data:with-space\ndata: without-space\n\n'])
    const events = await collectEvents(stream)
    expect(events).toEqual([{ event: undefined, data: 'with-space\nwithout-space' }])
  })

  it('assembles events split across multiple chunk boundaries', async () => {
    const stream = createChunkStream(['da', 'ta: first ', 'part\n', 'da', 'ta: second part', '\n\n'])
    const events = await collectEvents(stream)
    expect(events).toEqual([{ event: undefined, data: 'first part\nsecond part' }])
  })

  it('parses multiple events delivered in a single chunk', async () => {
    const stream = createChunkStream(['data: event1\n\ndata: event2\n\nevent: custom\ndata: event3\n\n'])
    const events = await collectEvents(stream)
    expect(events).toEqual([
      { event: undefined, data: 'event1' },
      { event: undefined, data: 'event2' },
      { event: 'custom', data: 'event3' },
    ])
  })

  it('flushes trailing data line at end of stream even if missing trailing double newline', async () => {
    const stream = createChunkStream(['data: trailing-line'])
    const events = await collectEvents(stream)
    expect(events).toEqual([{ event: undefined, data: 'trailing-line' }])
  })

  it('ignores consecutive empty lines without emitting blank events', async () => {
    const stream = createChunkStream(['\n\n\n\r\ndata: value\n\n\n\n'])
    const events = await collectEvents(stream)
    expect(events).toEqual([{ event: undefined, data: 'value' }])
  })

  it('rejects an individual SSE event exceeding 5 MiB character limit', async () => {
    const largeLine = `data: ${'a'.repeat(5 * 1024 * 1024 + 10)}\n\n`
    const stream = createChunkStream([largeLine])
    await expect(collectEvents(stream)).rejects.toThrow('供应商返回的单个流事件超过大小限制。')
  })

  it('rejects a buffer exceeding 5 MiB without newlines', async () => {
    const largeChunk = 'x'.repeat(5 * 1024 * 1024 + 10)
    const stream = createChunkStream([largeChunk])
    await expect(collectEvents(stream)).rejects.toThrow('供应商返回的流数据行超过大小限制。')
  })
})
