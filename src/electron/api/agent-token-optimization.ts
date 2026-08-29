import type {
  AgentTraceItem,
  McpToolDefinition,
  McpToolResultContent,
  Message,
  ToolCallExecution,
} from '../../shared/types'
import { REQUEST_OVERHEAD, RESERVED_SAFETY_TOKENS, estimateMessageTokens } from '../../shared/token-estimate'
import { DYNAMIC_TOOL_SEARCH_MODEL_NAME } from '../../shared/builtin-agent-tools'
import { retrieveRelevantTools } from '../mcp/tool-retriever'

const MODEL_CONTEXT_SUMMARY_ID = 'agentbox-model-context-summary'
const MODEL_CONTEXT_SUMMARY_PREFIX = '[AgentBox compacted earlier complete Agent tool turns]'
const SUMMARY_RESULT_PREVIEW_CHARACTERS = 320
const MAX_MODEL_REPLAY_IMAGE_CHARACTERS = 2 * 1024 * 1024

export interface FullToolResult {
  result: string
  resultContent?: McpToolResultContent[]
  structuredResult?: Record<string, unknown>
  resultTruncated?: boolean
  isError?: boolean
}

export type FullToolResultStore = Map<string, FullToolResult>

export interface TextChunk {
  text: string
  offset: number
  nextOffset: number
  totalCharacters: number
  hasMore: boolean
}

export interface AgentContextCompactionOptions {
  contextWindow: number
  maxOutputTokens: number
  thresholdPercent: number
  keepRecentTurns: number
}

/** Captures complete incoming results before a model-only copy is compacted. */
export function seedFullToolResultStore(messages: readonly Message[], store: FullToolResultStore): void {
  for (const message of messages) {
    for (const execution of message.toolExecutions || []) {
      if (execution.result === undefined) continue
      rememberFullToolResult(store, execution.id, resultFromExecution(execution))
    }
    for (const item of message.agentTrace || []) {
      if (item.type !== 'tool_result') continue
      rememberFullToolResult(store, item.callId, resultFromTrace(item))
    }
  }
}

export function rememberFullToolResult(store: FullToolResultStore, callId: string, result: FullToolResult): void {
  const candidate = structuredClone(result)
  const existing = store.get(callId)
  // A request can contain both toolExecutions and agentTrace. Prefer the most
  // complete representation and never replace a full value with its preview.
  if (!existing || formatFullToolResult(candidate).length > formatFullToolResult(existing).length) {
    store.set(callId, candidate)
  }
}

/**
 * Returns a model-only message copy whose complete tool results are replaced
 * by deterministic head/tail previews. The original messages and store stay
 * untouched for renderer persistence and chunked rereads.
 */
export function compactToolResultsForModel(messages: readonly Message[], maxCharacters: number): Message[] {
  const budget = normalizePreviewBudget(maxCharacters)
  return messages.map((message) => {
    if (!message.toolExecutions?.length && !message.agentTrace?.length) return message
    const next: Message = { ...message }
    const agentTraceOwnsToolResults = message.agentTrace?.some((item) => item.type === 'tool_result') ?? false
    if (message.toolExecutions?.length) {
      next.toolExecutions = message.toolExecutions.map((execution) => {
        if (execution.result === undefined) return execution
        const compacted = compactFullToolResult(resultFromExecution(execution), execution.id, budget)
        return compacted === undefined
          ? execution
          : {
              ...execution,
              result: compacted,
              resultContent: agentTraceOwnsToolResults
                ? undefined
                : retainModelReplayContent(resultFromExecution(execution).resultContent),
              structuredResult: undefined,
              resultTruncated: true,
            }
      })
    }
    if (message.agentTrace?.length) {
      next.agentTrace = message.agentTrace.map((item): AgentTraceItem => {
        if (item.type !== 'tool_result') return item
        const compacted = compactFullToolResult(resultFromTrace(item), item.callId, budget)
        return compacted === undefined
          ? item
          : {
              ...item,
              result: compacted,
              resultContent: retainModelReplayContent(resultFromTrace(item).resultContent),
              structuredResult: undefined,
              resultTruncated: true,
            }
      })
    }
    return next
  })
}

export function compactFullToolResult(
  result: FullToolResult,
  callId: string,
  maxCharacters: number,
): string | undefined {
  if (isCompactedToolResultPreview(result.result, callId)) return undefined
  const modelVisibleText = formatToolResultForModelBudget(result)
  if (modelVisibleText.length <= maxCharacters) return undefined
  return compactTextHeadTail(modelVisibleText, callId, maxCharacters)
}

function isCompactedToolResultPreview(result: string, callId: string): boolean {
  const quotedCallId = JSON.stringify(callId)
  return (
    result.includes(`[AgentBox tool result compacted; call_id=${quotedCallId};`) ||
    result.includes(`[compacted call_id=${quotedCallId}]`)
  )
}

export function compactTextHeadTail(text: string, callId: string, maxCharacters: number): string {
  const budget = normalizePreviewBudget(maxCharacters)
  if (text.length <= budget) return text
  const marker = `\n...[AgentBox tool result compacted; call_id=${JSON.stringify(callId)}; original_characters=${text.length}; use agentbox_read_tool_result with this call_id to read chunks.]...\n`
  if (marker.length >= budget) {
    const minimalMarker = `[compacted call_id=${JSON.stringify(callId)}]`
    return minimalMarker.length <= budget ? minimalMarker : minimalMarker.slice(0, budget)
  }
  const remaining = budget - marker.length
  const headLength = Math.ceil(remaining / 2)
  const tailLength = Math.floor(remaining / 2)
  return `${text.slice(0, headLength)}${marker}${text.slice(text.length - tailLength)}`
}

export function formatFullToolResult(result: FullToolResult): string {
  const sections: string[] = [result.result]
  if (result.resultContent?.length) {
    sections.push(`[result_content]\n${stableJson(result.resultContent)}`)
  }
  if (result.structuredResult) {
    sections.push(`[structured_result]\n${stableJson(result.structuredResult)}`)
  }
  return sections.filter((section) => section.length > 0).join('\n\n')
}

function formatToolResultForModelBudget(result: FullToolResult): string {
  const sections: string[] = [result.result]
  if (result.resultContent?.length) {
    sections.push(`[result_content]\n${stableJson(result.resultContent.map(describeModelResultContent))}`)
  }
  if (result.structuredResult) {
    sections.push(`[structured_result]\n${stableJson(result.structuredResult)}`)
  }
  return sections.filter((section) => section.length > 0).join('\n\n')
}

function describeModelResultContent(content: McpToolResultContent): Record<string, unknown> {
  if (content.type === 'image' || content.type === 'audio') {
    return {
      type: content.type,
      mimeType: content.mimeType,
      ...(content.data ? { data: `[${content.data.length} character binary payload retained separately]` } : {}),
    }
  }
  if (content.type === 'resource') {
    return {
      type: content.type,
      uri: content.uri,
      mimeType: content.mimeType,
      text: content.text,
      ...(content.blob ? { blob: `[${content.blob.length} character binary payload retained separately]` } : {}),
    }
  }
  return content
}

function retainModelReplayContent(content: McpToolResultContent[] | undefined): McpToolResultContent[] | undefined {
  let remainingCharacters = MAX_MODEL_REPLAY_IMAGE_CHARACTERS
  const replayable: McpToolResultContent[] = []
  for (const item of content ?? []) {
    if (item.type !== 'image' || !item.data || item.data.length > remainingCharacters) continue
    replayable.push(item)
    remainingCharacters -= item.data.length
  }
  return replayable.length ? replayable : undefined
}

export function readTextChunk(text: string, requestedOffset: number, requestedMaxCharacters: number): TextChunk {
  const offset = Math.min(text.length, Math.max(0, Math.trunc(requestedOffset)))
  const maxCharacters = Math.max(1, Math.trunc(requestedMaxCharacters))
  const nextOffset = Math.min(text.length, offset + maxCharacters)
  return {
    text: text.slice(offset, nextOffset),
    offset,
    nextOffset,
    totalCharacters: text.length,
    hasMore: nextOffset < text.length,
  }
}

/** Selects a bounded initial set from the complete authorized catalog. */
export function selectInitialDynamicTools(
  query: string,
  tools: readonly McpToolDefinition[],
  limit: number,
): McpToolDefinition[] {
  return retrieveRelevantTools(query, [...tools], { mode: 'auto', maxTools: normalizeToolLimit(limit) })
}

/** Searches only tools authorized for this request and not already exposed. */
export function searchAdditionalTools(
  query: string,
  authorizedTools: readonly McpToolDefinition[],
  exposedTools: readonly McpToolDefinition[],
  limit: number,
): McpToolDefinition[] {
  const exposed = new Set(exposedTools.map(toolIdentity))
  const remaining = authorizedTools.filter((tool) => !exposed.has(toolIdentity(tool)))
  if (remaining.length === 0) return []
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return []

  const exact = remaining.filter((tool) => {
    const names = [tool.name, tool.modelName].filter((name): name is string => Boolean(name))
    return names.some((name) => normalizedQuery === name.toLowerCase() || normalizedQuery.includes(name.toLowerCase()))
  })
  const ranked = retrieveRelevantTools(normalizedQuery, remaining, {
    mode: 'auto',
    maxTools: normalizeToolLimit(limit),
    minScore: 0.01,
  })
  return appendUniqueTools(exact, ranked).slice(0, normalizeToolLimit(limit))
}

export function appendUniqueTools(
  current: readonly McpToolDefinition[],
  additions: readonly McpToolDefinition[],
): McpToolDefinition[] {
  const result = [...current]
  const identities = new Set(result.map(toolIdentity))
  for (const tool of additions) {
    const identity = toolIdentity(tool)
    if (identities.has(identity)) continue
    identities.add(identity)
    result.push(tool)
  }
  return result
}

/** Restores successful search-tool mounts from a renderer-persisted checkpoint. */
export function restoreDynamicallyExposedTools(
  checkpoint: Message | undefined,
  authorizedTools: readonly McpToolDefinition[],
  initiallyExposedTools: readonly McpToolDefinition[],
  limit: number,
): McpToolDefinition[] {
  let exposed = [...initiallyExposedTools]
  if (!checkpoint?.agentTrace?.length) return exposed
  const successfulResults = new Set(
    checkpoint.agentTrace
      .filter(
        (item): item is Extract<AgentTraceItem, { type: 'tool_result' }> =>
          item.type === 'tool_result' && !item.isError,
      )
      .map((item) => item.callId),
  )
  for (const item of checkpoint.agentTrace) {
    if (
      item.type !== 'tool_call' ||
      item.modelToolName !== DYNAMIC_TOOL_SEARCH_MODEL_NAME ||
      !successfulResults.has(item.callId)
    ) {
      continue
    }
    const query = typeof item.args.query === 'string' ? item.args.query : ''
    const requestedLimit = typeof item.args.max_tools === 'number' ? item.args.max_tools : limit
    exposed = appendUniqueTools(
      exposed,
      searchAdditionalTools(query, authorizedTools, exposed, Math.min(requestedLimit, limit)),
    )
  }
  return exposed
}

/**
 * At the configured soft threshold, replaces only complete older tool-turn
 * messages after the latest user message. Whole call/result groups are
 * removed together, so every remaining provider replay stays protocol-valid.
 */
export function compactOlderAgentTurns(
  messages: readonly Message[],
  options: AgentContextCompactionOptions,
): Message[] {
  const inputBudget = options.contextWindow - options.maxOutputTokens - RESERVED_SAFETY_TOKENS
  if (inputBudget <= REQUEST_OVERHEAD) return [...messages]
  const thresholdPercent = Math.min(100, Math.max(1, options.thresholdPercent))
  const threshold = Math.floor((inputBudget * thresholdPercent) / 100)
  const estimate = REQUEST_OVERHEAD + messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
  if (estimate <= threshold) return [...messages]

  let latestUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      latestUserIndex = index
      break
    }
  }
  if (latestUserIndex < 0) return [...messages]

  const completeIndexes: number[] = []
  let previousSummaryIndex = -1
  for (let index = latestUserIndex + 1; index < messages.length; index += 1) {
    const message = messages[index]!
    if (message.id === MODEL_CONTEXT_SUMMARY_ID) previousSummaryIndex = index
    else if (isCompleteAgentToolTurn(message)) completeIndexes.push(index)
  }
  const keepRecentTurns = Math.max(0, Math.trunc(options.keepRecentTurns))
  const removableIndexes = completeIndexes.slice(0, Math.max(0, completeIndexes.length - keepRecentTurns))
  if (removableIndexes.length === 0) return [...messages]

  const removed = removableIndexes.map((index) => messages[index]!)
  const previousSummary = previousSummaryIndex >= 0 ? messages[previousSummaryIndex]?.content : undefined
  const summary: Message = {
    id: MODEL_CONTEXT_SUMMARY_ID,
    role: 'assistant',
    content: buildAgentTurnSummary(previousSummary, removed),
    createdAt: new Date(0).toISOString(),
  }
  const removedSet = new Set(removableIndexes)
  if (previousSummaryIndex >= 0) removedSet.add(previousSummaryIndex)
  const insertionIndex = Math.min(
    previousSummaryIndex >= 0 ? previousSummaryIndex : Number.MAX_SAFE_INTEGER,
    ...removableIndexes,
  )
  const compacted: Message[] = []
  for (let index = 0; index < messages.length; index += 1) {
    if (index === insertionIndex) compacted.push(summary)
    if (!removedSet.has(index)) compacted.push(messages[index]!)
  }
  return compacted
}

export function isCompleteAgentToolTurn(message: Message): boolean {
  if (message.role !== 'assistant') return false
  if (message.agentTrace?.length) {
    const calls = message.agentTrace.filter((item) => item.type === 'tool_call')
    if (calls.length === 0) return false
    const results = new Set(message.agentTrace.filter((item) => item.type === 'tool_result').map((item) => item.callId))
    return calls.every((call) => results.has(call.callId))
  }
  if (!message.toolExecutions?.length) return false
  return message.toolExecutions.every((execution) => ['complete', 'denied', 'error'].includes(execution.status))
}

function buildAgentTurnSummary(previousSummary: string | undefined, removed: readonly Message[]): string {
  const lines: string[] = [MODEL_CONTEXT_SUMMARY_PREFIX]
  if (previousSummary?.startsWith(MODEL_CONTEXT_SUMMARY_PREFIX)) {
    lines.push(
      ...previousSummary
        .slice(MODEL_CONTEXT_SUMMARY_PREFIX.length)
        .trim()
        .split('\n')
        .filter((line) => line && !line.startsWith('Complete results remain available by call_id')),
    )
  }
  for (const message of removed) {
    if (message.agentTrace?.length) {
      const assistantText = message.agentTrace
        .filter((item): item is Extract<AgentTraceItem, { type: 'assistant_text' }> => item.type === 'assistant_text')
        .map((item) => item.text)
        .join('')
      if (assistantText.trim()) {
        const turn = message.agentTrace[0]?.turn || 1
        lines.push(`- turn=${turn} assistant_text=${JSON.stringify(summaryPreview(assistantText))}`)
      }
      const results = new Map(
        message.agentTrace
          .filter((item): item is Extract<AgentTraceItem, { type: 'tool_result' }> => item.type === 'tool_result')
          .map((item) => [item.callId, item]),
      )
      for (const call of message.agentTrace.filter(
        (item): item is Extract<AgentTraceItem, { type: 'tool_call' }> => item.type === 'tool_call',
      )) {
        const result = results.get(call.callId)
        lines.push(
          `- turn=${call.turn} tool=${JSON.stringify(call.modelToolName)} call_id=${JSON.stringify(call.callId)} status=${result?.isError ? 'error' : 'complete'} result=${JSON.stringify(summaryPreview(result?.result || ''))}`,
        )
      }
      continue
    }
    for (const execution of message.toolExecutions || []) {
      lines.push(
        `- turn=${execution.turn || 1} tool=${JSON.stringify(execution.modelToolName || execution.toolName)} call_id=${JSON.stringify(execution.id)} status=${execution.isError ? 'error' : execution.status} result=${JSON.stringify(summaryPreview(execution.result || ''))}`,
      )
    }
  }
  lines.push(
    'Complete results remain available by call_id through agentbox_read_tool_result when that tool is exposed.',
  )
  return lines.join('\n')
}

function summaryPreview(result: string): string {
  if (result.length <= SUMMARY_RESULT_PREVIEW_CHARACTERS) return result
  const half = Math.floor((SUMMARY_RESULT_PREVIEW_CHARACTERS - 5) / 2)
  return `${result.slice(0, half)} ... ${result.slice(result.length - half)}`
}

function resultFromExecution(execution: ToolCallExecution): FullToolResult {
  return {
    result: execution.result || '',
    resultContent: execution.resultContent,
    structuredResult: execution.structuredResult,
    resultTruncated: execution.resultTruncated,
    isError: execution.isError,
  }
}

function resultFromTrace(item: Extract<AgentTraceItem, { type: 'tool_result' }>): FullToolResult {
  return {
    result: item.result,
    resultContent: item.resultContent,
    structuredResult: item.structuredResult,
    resultTruncated: item.resultTruncated,
    isError: item.isError,
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  )
}

function toolIdentity(tool: McpToolDefinition): string {
  return `${tool.serverId}\u0000${tool.modelName || tool.name}`
}

function normalizePreviewBudget(value: number): number {
  return Math.max(256, Math.trunc(value))
}

function normalizeToolLimit(value: number): number {
  return Math.min(100, Math.max(1, Math.trunc(value)))
}
