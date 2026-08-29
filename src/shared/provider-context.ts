import type { ProviderContinuation } from './types'

export function isValidProviderContinuation(value: unknown): value is ProviderContinuation {
  if (!value || typeof value !== 'object') return false
  const continuation = value as Partial<ProviderContinuation>
  return (
    continuation.format === 'openai-responses' &&
    typeof continuation.responseId === 'string' &&
    /^[A-Za-z0-9._:-]{1,200}$/.test(continuation.responseId) &&
    Number.isInteger(continuation.turn) &&
    Number(continuation.turn) >= 1 &&
    Number(continuation.turn) <= 101
  )
}
