import { describe, expect, it, vi } from 'vitest'
import { consumeStream } from '../src/electron/api/provider-stream'
import {
  monitorProviderBody,
  ProviderStreamBudget,
  PROVIDER_STREAM_LIMITS,
} from '../src/electron/api/provider-stream-budget'
import type { ApiFormat, StreamEvent } from '../src/shared/types'

function source(events: unknown[], open = false) {
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events)
        controller.enqueue(
          new TextEncoder().encode(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`),
        )
      if (!open) controller.close()
    },
    cancel,
  })
  return { body, cancel }
}

const formats: ApiFormat[] = ['openai-chat-completions', 'openai-responses', 'anthropic-messages']
function textDelta(format: ApiFormat, text: string) {
  if (format === 'openai-chat-completions') return { choices: [{ delta: { content: text } }] }
  if (format === 'openai-responses') return { type: 'response.output_text.delta', delta: text }
  return { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
}

describe('bounded provider stream consumption', () => {
  it.each(formats)('limits cumulative text before emitting an unsaveable delta (%s)', async (format) => {
    const input = source([textDelta(format, 'a'.repeat(1_100_000)), textDelta(format, 'b'.repeat(1_100_000))], true)
    const events: StreamEvent[] = []
    await expect(consumeStream(format, input.body, 'r', (event) => events.push(event))).rejects.toMatchObject({
      code: 'response_size_limit',
    })
    expect(events.filter((event) => event.type === 'text-delta').length).toBe(1)
    expect(input.cancel).toHaveBeenCalledOnce()
  })

  it('shares output budget across Agent model turns', async () => {
    const budget = new ProviderStreamBudget()
    budget.add('text', PROVIDER_STREAM_LIMITS.text - 2)
    const first = source([textDelta('openai-chat-completions', 'ok'), '[DONE]'])
    await consumeStream('openai-chat-completions', first.body, 'r', vi.fn(), [], 1, false, undefined, budget)
    const second = source([textDelta('openai-chat-completions', 'x')])
    await expect(
      consumeStream('openai-chat-completions', second.body, 'r', vi.fn(), [], 2, false, undefined, budget),
    ).rejects.toMatchObject({ code: 'response_size_limit' })
  })

  it.each(Object.keys(PROVIDER_STREAM_LIMITS) as Array<keyof typeof PROVIDER_STREAM_LIMITS>)(
    'enforces the %s budget at its exact boundary',
    (kind) => {
      const budget = new ProviderStreamBudget()
      budget.add(kind, PROVIDER_STREAM_LIMITS[kind])
      expect(() => budget.add(kind, 1)).toThrow()
    },
  )

  it('cancels the upstream locked reader after DONE without awaiting EOF', async () => {
    const input = source([textDelta('openai-chat-completions', 'ok'), '[DONE]'], true)
    const result = await consumeStream(
      'openai-chat-completions',
      monitorProviderBody(input.body, vi.fn(), new ProviderStreamBudget()),
      'r',
      vi.fn(),
    )
    expect(result.text).toBe('ok')
    expect(input.cancel).toHaveBeenCalledOnce()
    expect(input.body.locked).toBe(false)
  })

  it('reads on demand and propagates cancellation and cumulative byte errors', async () => {
    const pulls = vi.fn()
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls()
          controller.enqueue(new Uint8Array(2))
        },
        cancel,
      },
      { highWaterMark: 0 },
    )
    const budget = new ProviderStreamBudget()
    budget.add('wireBytes', PROVIDER_STREAM_LIMITS.wireBytes - 1)
    const monitored = monitorProviderBody(body, vi.fn(), budget)
    await Promise.resolve()
    expect(pulls).not.toHaveBeenCalled()
    const reader = monitored.getReader()
    await expect(reader.read()).rejects.toMatchObject({ code: 'response_size_limit' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
    reader.releaseLock()
  })

  it('limits individual tool arguments and the number of tool calls', async () => {
    const args = source([
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 't', arguments: 'x'.repeat(200_001) } }] } },
        ],
      },
    ])
    await expect(consumeStream('openai-chat-completions', args.body, 'r', vi.fn())).rejects.toMatchObject({
      code: 'response_size_limit',
    })
    const calls = source([
      {
        choices: [
          {
            delta: {
              tool_calls: Array.from({ length: 257 }, (_, index) => ({
                index,
                id: `c${index}`,
                function: { name: 't', arguments: '{}' },
              })),
            },
          },
        ],
      },
    ])
    await expect(consumeStream('openai-chat-completions', calls.body, 'r', vi.fn())).rejects.toMatchObject({
      code: 'response_size_limit',
    })
  })
})
