import type { ModelRequestUsage, TokenUsage, TokenUsageDetails } from './types'

const SUMMED_USAGE_FIELDS = [
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'cachedInputTokens',
  'cacheWriteTokens',
  'webSearchRequests',
] as const satisfies readonly (keyof TokenUsageDetails)[]

const USAGE_DETAIL_FIELDS = [
  ...SUMMED_USAGE_FIELDS,
  'totalTokens',
] as const satisfies readonly (keyof TokenUsageDetails)[]

/**
 * Merges one provider usage fragment into its model request, then derives the
 * assistant-message totals from every request completed so far.
 */
export function mergeTokenUsage(current: TokenUsage | undefined, partial: TokenUsageDetails, turn: number): TokenUsage {
  const normalizedTurn = Number.isInteger(turn) && turn > 0 ? turn : 1
  const modelRequests = current?.modelRequests?.length
    ? current.modelRequests.map((request) => ({ ...request }))
    : legacyModelRequests(current)
  const index = modelRequests.findIndex((request) => request.turn === normalizedTurn)
  const existing = index >= 0 ? modelRequests[index] : undefined
  const merged = mergeUsageDetails(existing, partial)
  const request: ModelRequestUsage = { turn: normalizedTurn, ...merged }
  if (index >= 0) modelRequests[index] = request
  else modelRequests.push(request)
  modelRequests.sort((left, right) => left.turn - right.turn)
  return aggregateModelRequestUsage(modelRequests)
}

/** Recomputes canonical message totals without counting cached tokens twice. */
export function aggregateModelRequestUsage(modelRequests: readonly ModelRequestUsage[]): TokenUsage {
  const totals: TokenUsageDetails = {}
  for (const field of SUMMED_USAGE_FIELDS) {
    const values: number[] = []
    for (const request of modelRequests) {
      const value = request[field]
      if (value !== undefined) values.push(value)
    }
    if (values.length > 0) totals[field] = values.reduce((sum, value) => sum + value, 0)
  }

  const hasTotalBasis = modelRequests.some(
    (request) =>
      request.totalTokens !== undefined || request.inputTokens !== undefined || request.outputTokens !== undefined,
  )
  if (hasTotalBasis) {
    totals.totalTokens = modelRequests.reduce(
      (sum, request) => sum + (request.totalTokens ?? (request.inputTokens ?? 0) + (request.outputTokens ?? 0)),
      0,
    )
  }

  return {
    ...totals,
    modelRequests: modelRequests.map((request) => ({ ...request })),
  }
}

function legacyModelRequests(usage: TokenUsage | undefined): ModelRequestUsage[] {
  if (!usage) return []
  const details = pickUsageDetails(usage)
  return Object.keys(details).length > 0 ? [{ turn: 1, ...details }] : []
}

function mergeUsageDetails(current: TokenUsageDetails | undefined, partial: TokenUsageDetails): TokenUsageDetails {
  const merged = pickUsageDetails(current)
  for (const field of USAGE_DETAIL_FIELDS) {
    const value = partial[field]
    if (value !== undefined) merged[field] = value
  }
  return merged
}

function pickUsageDetails(usage: TokenUsageDetails | undefined): TokenUsageDetails {
  const details: TokenUsageDetails = {}
  if (!usage) return details
  for (const field of USAGE_DETAIL_FIELDS) {
    const value = usage[field]
    if (value !== undefined) details[field] = value
  }
  return details
}
