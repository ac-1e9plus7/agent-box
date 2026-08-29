import type { ModelRequestUsage, TokenUsage, TokenUsageDetails, WebCitation, WebSearchMode } from '../../shared/types'
import { MAX_AGENT_TOOL_TURN_LIMIT } from '../../shared/agent-limits'
import { aggregateModelRequestUsage } from '../../shared/token-usage'

export const MAX_CITATIONS_PER_MESSAGE = 100
export const MAX_CITATION_VARIANTS_PER_STREAM = 300
const MAX_CITATION_URL_CHARACTERS = 4_096
const MAX_CITATION_TITLE_CHARACTERS = 2_000
const MAX_CITATION_CONTENT_CHARACTERS = 100_000
const MAX_USAGE_VALUE = 1_000_000_000_000
const MAX_CITATION_INDEX = 100_000_000

export function parseOptionalWebSearchMode(value: unknown, label = 'web search mode'): WebSearchMode | undefined {
  if (value === undefined) return undefined
  if (!['off', 'auto', 'native'].includes(String(value))) {
    throw new Error(`Invalid ${label}`)
  }
  return value as WebSearchMode
}

export function parseStoredCitations(value: unknown): WebCitation[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > MAX_CITATIONS_PER_MESSAGE) {
    throw new Error('Invalid message citations')
  }
  const citations = value.map(parseWebCitation)
  return citations.length ? citations : undefined
}

export function parseWebCitation(value: unknown): WebCitation {
  if (!isRecord(value)) throw new Error('Invalid web citation')
  const url = normalizeCitationUrl(value.url)
  const title = optionalBoundedString(value.title, MAX_CITATION_TITLE_CHARACTERS, 'citation title')
  const content = optionalBoundedString(value.content, MAX_CITATION_CONTENT_CHARACTERS, 'citation content')
  const startIndex = optionalBoundedInteger(value.startIndex, 'citation start index')
  const endIndex = optionalBoundedInteger(value.endIndex, 'citation end index')
  if (startIndex !== undefined && endIndex !== undefined && endIndex < startIndex) {
    throw new Error('Invalid citation range')
  }
  return removeUndefined({ url, title, content, startIndex, endIndex }) as WebCitation
}

export function normalizeCitationUrl(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > MAX_CITATION_URL_CHARACTERS) {
    throw new Error('Invalid citation URL')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Invalid citation URL')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Invalid citation URL')
  }
  const normalized = url.toString()
  if (normalized.length > MAX_CITATION_URL_CHARACTERS) {
    throw new Error('Invalid citation URL')
  }
  return normalized
}

export function parseStoredTokenUsage(value: unknown): TokenUsage | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error('Invalid message usage')
  if (value.modelRequests === undefined) {
    const usage = parseStoredUsageDetails(value)
    return Object.keys(usage).length ? usage : undefined
  }
  if (!Array.isArray(value.modelRequests) || value.modelRequests.length < 1) {
    throw new Error('Invalid model request usage')
  }
  if (value.modelRequests.length > MAX_AGENT_TOOL_TURN_LIMIT + 1) {
    throw new Error('Invalid model request usage')
  }
  const turns = new Set<number>()
  const modelRequests = value.modelRequests.map((request): ModelRequestUsage => {
    if (!isRecord(request)) throw new Error('Invalid model request usage')
    const turn = optionalUsageInteger(request.turn, 'model request turn')
    if (turn === undefined || turn < 1 || turn > MAX_AGENT_TOOL_TURN_LIMIT + 1 || turns.has(turn)) {
      throw new Error('Invalid model request turn')
    }
    turns.add(turn)
    const details = parseStoredUsageDetails(request)
    if (Object.keys(details).length === 0) throw new Error('Invalid model request usage')
    return { turn, ...details }
  })
  modelRequests.sort((left, right) => left.turn - right.turn)
  return aggregateModelRequestUsage(modelRequests)
}

function parseStoredUsageDetails(value: Record<string, unknown>): TokenUsageDetails {
  return removeUndefined({
    inputTokens: optionalUsageInteger(value.inputTokens, 'input token usage'),
    outputTokens: optionalUsageInteger(value.outputTokens, 'output token usage'),
    reasoningTokens: optionalUsageInteger(value.reasoningTokens, 'reasoning token usage'),
    cachedInputTokens: optionalUsageInteger(value.cachedInputTokens, 'cached input token usage'),
    cacheWriteTokens: optionalUsageInteger(value.cacheWriteTokens, 'cache write token usage'),
    webSearchRequests: optionalUsageInteger(value.webSearchRequests, 'web search request usage'),
    totalTokens: optionalUsageInteger(value.totalTokens, 'total token usage'),
  })
}

export function isValidTokenUsageValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_USAGE_VALUE
}

export function citationCharacterCount(citations?: WebCitation[]): number {
  return (citations ?? []).reduce(
    (total, citation) => total + citation.url.length + (citation.title?.length ?? 0) + (citation.content?.length ?? 0),
    0,
  )
}

export interface CitationEmissionState {
  byUrl: Map<string, { citation: WebCitation; fingerprint: string }>
  variants: number
}

export function createCitationEmissionState(): CitationEmissionState {
  return { byUrl: new Map(), variants: 0 }
}

/**
 * Suppresses exact repeats while allowing a later terminal event to enrich the
 * same URL with a title, excerpt, or range. Both unique URLs and variants are
 * bounded so an untrusted stream cannot grow renderer/main-process memory
 * without limit.
 */
export function takeChangedWebCitations(
  citations: WebCitation[] | undefined,
  state: CitationEmissionState,
): WebCitation[] {
  const fresh: WebCitation[] = []
  for (const citation of citations ?? []) {
    let sanitized: WebCitation
    try {
      sanitized = parseWebCitation(citation)
    } catch {
      continue
    }
    const previous = state.byUrl.get(sanitized.url)
    const merged = previous
      ? (removeUndefined({
          url: sanitized.url,
          title: sanitized.title ?? previous.citation.title,
          content: sanitized.content ?? previous.citation.content,
          startIndex: sanitized.startIndex ?? previous.citation.startIndex,
          endIndex: sanitized.endIndex ?? previous.citation.endIndex,
        }) as WebCitation)
      : sanitized
    const fingerprint = JSON.stringify([merged.url, merged.title, merged.content, merged.startIndex, merged.endIndex])
    if (previous?.fingerprint === fingerprint) continue
    if (!previous && state.byUrl.size >= MAX_CITATIONS_PER_MESSAGE) {
      continue
    }
    if (state.variants >= MAX_CITATION_VARIANTS_PER_STREAM) continue
    state.byUrl.set(merged.url, { citation: merged, fingerprint })
    state.variants += 1
    fresh.push(merged)
  }
  return fresh
}

function optionalBoundedString(value: unknown, maximum: number, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > maximum) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function optionalBoundedInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > MAX_CITATION_INDEX) {
    throw new Error(`Invalid ${label}`)
  }
  return Number(value)
}

function optionalUsageInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (!isValidTokenUsageValue(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function removeUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
