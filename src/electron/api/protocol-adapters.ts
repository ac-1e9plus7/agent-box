import type { TokenUsage, WebCitation } from '../../shared/types'
import {
  isValidTokenUsageValue,
  MAX_CITATION_VARIANTS_PER_STREAM,
  parseWebCitation,
} from '../storage/web-metadata-schema'
import { t } from '../../shared/i18n'

export interface ProtocolErrorData {
  message: string
  code?: string
  status?: number
}

export interface RawToolCallDelta {
  index?: number
  id?: string
  itemId?: string
  name?: string
  argumentsDelta?: string
}

export interface ParsedProtocolEvent {
  text?: string
  reasoning?: string
  citations?: WebCitation[]
  toolCallDeltas?: RawToolCallDelta[]
  anthropicThinkingDelta?: { index: number; thinkingDelta?: string; signatureDelta?: string }
  responseOutputItem?: Record<string, unknown>
  usage?: TokenUsage
  finishReason?: string
  completed?: boolean
  error?: ProtocolErrorData
}

export function parseChatCompletionEvent(value: unknown): ParsedProtocolEvent {
  if (!isRecord(value)) return {}
  if (isRecord(value.error)) return { error: payloadError(value.error) }
  const choice = Array.isArray(value.choices) && isRecord(value.choices[0]) ? value.choices[0] : undefined
  const delta = choice && isRecord(choice.delta) ? choice.delta : undefined
  const message = choice && isRecord(choice.message) ? choice.message : undefined
  const text = extractChatDeltaText(delta?.content) ?? (typeof delta?.refusal === 'string' ? delta.refusal : undefined)
  let reasoning =
    typeof delta?.reasoning === 'string'
      ? delta.reasoning
      : typeof delta?.reasoning_content === 'string'
        ? delta.reasoning_content
        : undefined
  if (!reasoning && Array.isArray(delta?.reasoning_details)) {
    reasoning = reasoningDetailsToText(delta.reasoning_details)
  }
  const citations = extractWebCitations(
    delta?.annotations,
    message?.annotations,
    choice?.annotations,
    value.annotations,
  )

  const toolCallDeltas = Array.isArray(delta?.tool_calls)
    ? delta.tool_calls.flatMap((value, fallbackIndex) => {
        if (!isRecord(value)) return []
        const func = isRecord(value.function) ? value.function : undefined
        return [
          {
            index: typeof value.index === 'number' ? value.index : fallbackIndex,
            id: typeof value.id === 'string' ? value.id : undefined,
            name: typeof func?.name === 'string' ? func.name : undefined,
            argumentsDelta: typeof func?.arguments === 'string' ? func.arguments : undefined,
          },
        ]
      })
    : []

  return {
    text,
    reasoning,
    citations: citations.length ? citations : undefined,
    toolCallDeltas: toolCallDeltas.length ? toolCallDeltas : undefined,
    usage: parseUsage(value.usage),
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined,
  }
}

export function parseResponsesEvent(value: unknown, sseEvent?: string): ParsedProtocolEvent {
  if (!isRecord(value)) return {}
  const type = typeof value.type === 'string' ? value.type : sseEvent
  if (type === 'error' || type === 'response.failed') {
    const error = isRecord(value.error)
      ? value.error
      : isRecord(value.response) && isRecord(value.response.error)
        ? value.response.error
        : value
    return {
      error: payloadError(error, typeof value.error_type === 'string' ? value.error_type : undefined),
    }
  }

  const response = isRecord(value.response) ? value.response : undefined
  const usage = parseUsage(response?.usage ?? value.usage)
  const citations = extractResponsesCitations(value, response)
  const deltaRecord = isRecord(value.delta) ? value.delta : undefined
  const delta =
    typeof value.delta === 'string' ? value.delta : typeof deltaRecord?.text === 'string' ? deltaRecord.text : undefined
  if (type === 'response.output_text.delta' || type === 'response.content_part.delta') {
    const part = isRecord(value.part) ? value.part : undefined
    return {
      text: delta ?? (typeof part?.text === 'string' ? part.text : undefined),
      citations: citations.length ? citations : undefined,
    }
  }
  if (type === 'response.refusal.delta') {
    return { text: delta, citations: citations.length ? citations : undefined }
  }
  if (type === 'response.function_call_arguments.delta') {
    return {
      toolCallDeltas: [
        {
          index: typeof value.output_index === 'number' ? value.output_index : undefined,
          itemId: typeof value.item_id === 'string' ? value.item_id : undefined,
          argumentsDelta: typeof value.delta === 'string' ? value.delta : undefined,
        },
      ],
    }
  }
  if (type === 'response.output_item.added' && isRecord(value.item)) {
    const item = value.item
    if (item.type === 'function_call') {
      return {
        toolCallDeltas: [
          {
            index: typeof value.output_index === 'number' ? value.output_index : undefined,
            itemId: typeof item.id === 'string' ? item.id : undefined,
            id: typeof item.call_id === 'string' ? item.call_id : typeof item.id === 'string' ? item.id : undefined,
            name: typeof item.name === 'string' ? item.name : undefined,
            argumentsDelta: typeof item.arguments === 'string' ? item.arguments : undefined,
          },
        ],
      }
    }
  }
  if (type === 'response.output_item.done' && isRecord(value.item) && value.item.type === 'reasoning') {
    return { responseOutputItem: value.item }
  }
  if (typeof type === 'string' && type.startsWith('response.reasoning') && delta) {
    // Covers response.reasoning.delta, response.reasoning_text.delta,
    // response.reasoning_summary_text.delta, and any future reasoning-part
    // variants OpenRouter surfaces for Gemini/other models. Only emit when a
    // text delta is present so terminal reasoning events (e.g. .done) don't
    // surface empty reasoning.
    return { reasoning: delta, citations: citations.length ? citations : undefined }
  }
  if (type === 'response.completed' || type === 'response.done' || type === 'response.incomplete') {
    const incompleteDetails = isRecord(response?.incomplete_details)
      ? response.incomplete_details
      : isRecord(value.incomplete_details)
        ? value.incomplete_details
        : undefined
    return {
      completed: true,
      usage,
      citations: citations.length ? citations : undefined,
      finishReason:
        typeof incompleteDetails?.reason === 'string'
          ? incompleteDetails.reason
          : typeof response?.status === 'string'
            ? response.status
            : typeof value.status === 'string'
              ? value.status
              : 'completed',
    }
  }
  return removeUndefined({
    usage,
    citations: citations.length ? citations : undefined,
  })
}

export function parseAnthropicEvent(value: unknown, sseEvent?: string): ParsedProtocolEvent {
  if (!isRecord(value)) return {}
  const type = typeof value.type === 'string' ? value.type : sseEvent
  if (type === 'error') {
    return { error: payloadError(isRecord(value.error) ? value.error : value) }
  }
  if (type === 'content_block_start' && isRecord(value.content_block)) {
    const block = value.content_block
    const citations = extractWebCitations(block.citations, value.citations)
    if (block.type === 'text' && typeof block.text === 'string') {
      return { text: block.text, citations: citations.length ? citations : undefined }
    }
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      return {
        reasoning: block.thinking,
        anthropicThinkingDelta: {
          index: typeof value.index === 'number' ? value.index : 0,
          thinkingDelta: block.thinking,
          signatureDelta: typeof block.signature === 'string' ? block.signature : undefined,
        },
      }
    }
    if (block.type === 'tool_use') {
      return {
        toolCallDeltas: [
          {
            index: typeof value.index === 'number' ? value.index : 0,
            id: typeof block.id === 'string' ? block.id : undefined,
            name: typeof block.name === 'string' ? block.name : undefined,
          },
        ],
      }
    }
  }
  if (type === 'content_block_delta' && isRecord(value.delta)) {
    const citations = extractWebCitations(value.delta.citations, value.delta.citation, value.citations)
    if (value.delta.type === 'text_delta' && typeof value.delta.text === 'string') {
      return {
        text: value.delta.text,
        citations: citations.length ? citations : undefined,
      }
    }
    if (value.delta.type === 'thinking_delta' && typeof value.delta.thinking === 'string') {
      return {
        reasoning: value.delta.thinking,
        anthropicThinkingDelta: {
          index: typeof value.index === 'number' ? value.index : 0,
          thinkingDelta: value.delta.thinking,
        },
      }
    }
    if (value.delta.type === 'signature_delta' && typeof value.delta.signature === 'string') {
      return {
        anthropicThinkingDelta: {
          index: typeof value.index === 'number' ? value.index : 0,
          signatureDelta: value.delta.signature,
        },
      }
    }
    if (value.delta.type === 'input_json_delta' && typeof value.delta.partial_json === 'string') {
      return {
        toolCallDeltas: [
          {
            index: typeof value.index === 'number' ? value.index : 0,
            argumentsDelta: value.delta.partial_json,
          },
        ],
      }
    }
    if (citations.length) return { citations }
  }
  if (type === 'message_start' && isRecord(value.message)) {
    return { usage: parseUsage(value.message.usage) }
  }
  if (type === 'message_delta') {
    const delta = isRecord(value.delta) ? value.delta : undefined
    return {
      usage: parseUsage(value.usage),
      finishReason: typeof delta?.stop_reason === 'string' ? delta.stop_reason : undefined,
    }
  }
  if (type === 'message_stop') {
    const citations = extractAnthropicMessageCitations(value)
    return removeUndefined({
      completed: true,
      usage: parseUsage(value.usage),
      citations: citations.length ? citations : undefined,
    })
  }
  const citations = extractWebCitations(value.citations, value.citation)
  if (citations.length) return { citations }
  return {}
}

export function parseUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined
  const outputDetails = isRecord(value.output_tokens_details) ? value.output_tokens_details : undefined
  const completionDetails = isRecord(value.completion_tokens_details) ? value.completion_tokens_details : undefined
  const serverToolUse = isRecord(value.server_tool_use) ? value.server_tool_use : undefined
  const usage = removeUndefined({
    inputTokens: firstNumber(value.input_tokens, value.prompt_tokens),
    outputTokens: firstNumber(value.output_tokens, value.completion_tokens),
    reasoningTokens: firstNumber(
      outputDetails?.reasoning_tokens,
      outputDetails?.thinking_tokens,
      completionDetails?.reasoning_tokens,
    ),
    webSearchRequests: firstNumber(serverToolUse?.web_search_requests),
    totalTokens: firstNumber(value.total_tokens),
  }) as TokenUsage
  return Object.keys(usage).length ? usage : undefined
}

function extractChatDeltaText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return undefined
  const text = value
    .map((part) => {
      if (typeof part === 'string') return part
      if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
        return part.text
      }
      return ''
    })
    .join('')
  return text || undefined
}

/**
 * Concatenates OpenRouter `reasoning_details` entries into displayable
 * thinking text. OpenRouter normalizes every provider (Anthropic, OpenAI, and
 * Google Gemini's `google-gemini-v1` format) into entries typed
 * `reasoning.text` (carrying `text`) or `reasoning.summary` (carrying
 * `summary`). We read either field so thinking is shown regardless of which
 * variant a model emits; entries with neither are ignored.
 */
function reasoningDetailsToText(details: unknown[]): string | undefined {
  const text = details
    .map((detail) => {
      if (!isRecord(detail)) return ''
      if (typeof detail.text === 'string') return detail.text
      if (typeof detail.summary === 'string') return detail.summary
      return ''
    })
    .join('')
  return text || undefined
}

export function extractWebCitations(...sources: unknown[]): WebCitation[] {
  const citations: WebCitation[] = []
  for (const source of sources) {
    const annotations = Array.isArray(source) ? source : source === undefined ? [] : [source]
    for (const annotation of annotations) {
      const citation = toWebCitation(annotation)
      if (citation) citations.push(citation)
      if (citations.length >= MAX_CITATION_VARIANTS_PER_STREAM) return citations
    }
  }
  return citations
}

function extractResponsesCitations(value: Record<string, unknown>, response?: Record<string, unknown>): WebCitation[] {
  const part = isRecord(value.part) ? value.part : undefined
  const delta = isRecord(value.delta) ? value.delta : undefined
  const sources: unknown[] = [
    value.annotation,
    value.annotations,
    part?.annotation,
    part?.annotations,
    delta?.annotation,
    delta?.annotations,
  ]
  collectOutputAnnotationSources(value.item, sources)
  collectOutputAnnotationSources(value.output, sources)
  collectOutputAnnotationSources(response?.output, sources)
  return extractWebCitations(...sources)
}

function extractAnthropicMessageCitations(value: Record<string, unknown>): WebCitation[] {
  const sources: unknown[] = [value.citation, value.citations]
  const message = isRecord(value.message) ? value.message : undefined
  collectOutputAnnotationSources(value.content, sources)
  collectOutputAnnotationSources(message?.content, sources)
  return extractWebCitations(...sources)
}

function collectOutputAnnotationSources(value: unknown, sources: unknown[]): void {
  const entries = Array.isArray(value) ? value : value === undefined ? [] : [value]
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    sources.push(entry.annotation, entry.annotations, entry.citation, entry.citations)
    if (Array.isArray(entry.content)) {
      for (const content of entry.content) {
        if (!isRecord(content)) continue
        sources.push(content.annotation, content.annotations, content.citation, content.citations)
      }
    }
  }
}

function toWebCitation(annotation: unknown): WebCitation | undefined {
  if (!isRecord(annotation)) return undefined
  const nested = isRecord(annotation.url_citation) ? annotation.url_citation : undefined
  const source = nested ?? annotation
  const annotationType =
    typeof annotation.type === 'string' ? annotation.type : typeof source.type === 'string' ? source.type : undefined
  if (
    !nested &&
    annotationType !== 'url_citation' &&
    annotationType !== 'web_search_result_location' &&
    annotationType !== 'web_search_result'
  ) {
    return undefined
  }
  try {
    return parseWebCitation({
      url: source.url,
      title: source.title === null ? undefined : source.title,
      content:
        typeof source.content === 'string'
          ? source.content
          : typeof source.cited_text === 'string'
            ? source.cited_text
            : undefined,
      startIndex: source.start_index ?? source.startIndex,
      endIndex: source.end_index ?? source.endIndex,
    })
  } catch {
    return undefined
  }
}

function payloadError(value: Record<string, unknown>, fallbackCode?: string): ProtocolErrorData {
  const metadata = isRecord(value.metadata) ? value.metadata : undefined
  return removeUndefined({
    message: typeof value.message === 'string' ? value.message : t('The model provider returned an error.'),
    code:
      typeof value.error_type === 'string'
        ? value.error_type
        : typeof metadata?.error_type === 'string'
          ? metadata.error_type
          : typeof value.code === 'string'
            ? value.code
            : typeof value.type === 'string'
              ? value.type
              : fallbackCode,
    status: typeof value.status === 'number' ? value.status : undefined,
  }) as ProtocolErrorData
}

function firstNumber(...values: unknown[]): number | undefined {
  return values.find(isValidTokenUsageValue)
}

function removeUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
