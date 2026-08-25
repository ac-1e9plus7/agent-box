import type { ContextManagementMode, Message } from '../../shared/types'
import {
  REQUEST_OVERHEAD,
  RESERVED_SAFETY_TOKENS,
  estimateMessageTokens,
  estimateTextTokens,
} from '../../shared/token-estimate'
import { t } from '../../shared/i18n'

// Re-exported so existing import sites keep working; the estimate now lives in
// the shared module and is reused by the renderer context projection.
export { estimateMessageTokens, estimateTextTokens }

export class ContextWindowError extends Error {
  readonly code = 'context_window_exceeded'

  constructor(message: string) {
    super(message)
    this.name = 'ContextWindowError'
  }
}

export interface ContextPreparationResult {
  messages: Message[]
  estimatedInputTokens: number
  removedMessageCount: number
}

export function resolveContextManagementMode(
  configuredMode: ContextManagementMode,
  allowContextTrimming?: boolean,
): ContextManagementMode {
  return allowContextTrimming ? 'auto' : configuredMode
}

/**
 * Removes the oldest expendable turns until the prompt fits the configured
 * window. System messages and the most recent user message are never removed.
 */
export function prepareMessagesForContext(
  messages: Message[],
  contextWindow: number,
  maxOutputTokens: number,
  mode: ContextManagementMode = 'manual',
): ContextPreparationResult {
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
    throw new Error(t('The model context window configuration is invalid.'))
  }
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new Error(t('The model maximum output length configuration is invalid.'))
  }

  const inputBudget = contextWindow - maxOutputTokens - RESERVED_SAFETY_TOKENS
  if (inputBudget <= REQUEST_OVERHEAD) {
    throw new ContextWindowError(
      t(
        'The context window cannot reserve enough room for model output. Reduce the maximum output tokens or increase the model context window.',
      ),
    )
  }

  const systemMessages = messages.filter((message) => message.role === 'system')
  const turns = groupConversationTurns(messages)
  const latestTurn = turns.at(-1)
  if (!latestTurn?.some((message) => message.role === 'user')) {
    throw new Error(t('The content sent must contain user messages.'))
  }
  const fullInputEstimate =
    REQUEST_OVERHEAD + messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)

  if (mode === 'manual') {
    if (fullInputEstimate > inputBudget) {
      throw new ContextWindowError(
        t(
          'This conversation is estimated to require {value0} input tokens, but only about {value1} are available for this model.',
          { value0: fullInputEstimate, value1: inputBudget },
        ) +
          t(
            'Create a new conversation, shorten the system prompt or latest user request, or reduce the maximum output tokens,',
          ) +
          t('Choose “Trim this request automatically” or enable “Automatic trimming” in Settings.'),
      )
    }
    return {
      messages: [...messages],
      estimatedInputTokens: fullInputEstimate,
      removedMessageCount: 0,
    }
  }

  if (mode !== 'auto') throw new Error(t('Invalid context management mode.'))
  let used = REQUEST_OVERHEAD
  used += systemMessages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
  used += latestTurn.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
  if (used > inputBudget) {
    throw new ContextWindowError(
      t('The system prompt and final user message exceed the model’s available context.') +
        t('Shorten the system prompt or final message, or reduce the maximum output tokens.'),
    )
  }

  const selectedTurns: Message[][] = [latestTurn]
  for (let index = turns.length - 2; index >= 0; index -= 1) {
    const turn = turns[index]!
    const cost = turn.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
    if (used + cost > inputBudget) break
    selectedTurns.unshift(turn)
    used += cost
  }

  const selectedMessages = new Set([...systemMessages, ...selectedTurns.flat()])
  const prepared = messages.filter((message) => selectedMessages.has(message))
  return {
    messages: prepared,
    estimatedInputTokens: used,
    removedMessageCount: messages.length - prepared.length,
  }
}

function groupConversationTurns(messages: Message[]): Message[][] {
  const turns: Message[][] = []
  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'user') turns.push([message])
    else if (turns.length > 0) turns.at(-1)!.push(message)
  }
  return turns
}
