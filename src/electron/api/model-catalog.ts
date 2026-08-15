import type { ReasoningEffort, RemoteModel } from '../../shared/types'

export function toRemoteModel(value: unknown): RemoteModel | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length > 500) {
    return undefined
  }
  const topProvider = isRecord(value.top_provider) ? value.top_provider : undefined
  const reasoning = isRecord(value.reasoning) ? value.reasoning : undefined
  const supported = Array.isArray(value.supported_parameters)
    ? value.supported_parameters.filter((item): item is string => typeof item === 'string')
    : []
  const efforts = Array.isArray(reasoning?.supported_efforts)
    ? reasoning.supported_efforts.filter(isReasoningEffort)
    : undefined
  return removeUndefined({
    id: value.id,
    name: firstBoundedString(500, value.display_name, value.name, value.id) ?? value.id,
    description: firstBoundedString(10_000, value.description),
    contextWindow: firstPositiveNumber(
      value.context_length,
      value.context_window,
      value.max_context_length,
      value.max_context_window,
      value.max_input_tokens,
    ),
    maxOutputTokens: firstPositiveNumber(
      topProvider?.max_completion_tokens,
      value.max_completion_tokens,
      value.max_output_tokens,
      value.max_tokens,
    ),
    supportsReasoning:
      Boolean(reasoning) ||
      supported.some((parameter) =>
        ['reasoning', 'reasoning_effort', 'include_reasoning'].includes(parameter),
      ),
    supportedReasoningEfforts: efforts,
  }) as unknown as RemoteModel
}

function firstBoundedString(maximum: number, ...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string =>
      typeof value === 'string' && value.length > 0 && value.length <= maximum,
  )
}

function firstPositiveNumber(...values: unknown[]): number | undefined {
  return values.find(
    (value): value is number =>
      typeof value === 'number' && Number.isFinite(value) && value > 0,
  )
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    typeof value === 'string' &&
    ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)
  )
}

function removeUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
