import { GatewayError } from './gateway-error'
import { t } from '../../shared/i18n'

export const PROVIDER_STREAM_LIMITS = {
  wireBytes: 64 * 1024 * 1024,
  text: 2_000_000,
  reasoning: 2_000_000,
  signatures: 2_000_000,
  toolArguments: 2_000_000,
  toolCalls: 256,
  providerItems: 128,
  providerItemCharacters: 8_000_000,
  thinkingBlocks: 128,
} as const

/** One budget spans every provider turn in a single user request. */
export class ProviderStreamBudget {
  private readonly used = new Map<keyof typeof PROVIDER_STREAM_LIMITS, number>()

  add(kind: keyof typeof PROVIDER_STREAM_LIMITS, amount: number): void {
    const next = (this.used.get(kind) ?? 0) + amount
    if (next > PROVIDER_STREAM_LIMITS[kind]) {
      throw new GatewayError(t('The provider response exceeded the request size limit.'), 'response_size_limit')
    }
    this.used.set(kind, next)
  }
}

/** Pull through the locked reader; cancellation always reaches that same reader. */
export function monitorProviderBody(
  body: ReadableStream<Uint8Array>,
  onActivity: () => void,
  budget: ProviderStreamBudget,
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let released = false
  const release = () => {
    if (!released) {
      released = true
      reader.releaseLock()
    }
  }
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { value, done } = await reader.read()
          onActivity()
          if (done) {
            release()
            controller.close()
            return
          }
          budget.add('wireBytes', value.byteLength)
          controller.enqueue(value)
        } catch (error) {
          await reader.cancel().catch(() => undefined)
          release()
          controller.error(error)
        }
      },
      async cancel() {
        try {
          await reader.cancel()
        } finally {
          release()
        }
      },
    },
    { highWaterMark: 0 },
  )
}
