import type { AppSettings, Message, ModelConfig } from '../../shared/types'
import { REQUEST_OVERHEAD, RESERVED_SAFETY_TOKENS, estimateMessageTokens } from '../../shared/token-estimate'
import { getLanguage, t } from '../../shared/i18n'
import { normalizeMessageContent } from '../../shared/message-content'

/**
 * Accepts the structural subset of a message that the projection needs. The
 * renderer's `ChatMessage` extends `Message` with display-only fields, so
 * `ChatMessage[]` is assignable here without coupling this module to renderer
 * types (and keeps it testable from the node project).
 */
export type ProjectionMessage = Pick<Message, 'role' | 'content'> & { attachments?: Message['attachments'] }

export interface ContextProjection {
  estimatedInputTokens: number
  inputBudget: number
  blocked: boolean
  canTrimOnce: boolean
  trimTurnCount: number
  tone: 'ok' | 'warning' | 'error'
  message: string
}

/**
 * Projects the input-token cost of the current conversation plus a pending
 * draft against the active model's context budget. This is a *preview* of what
 * the main-process `prepareMessagesForContext` will do, so it must use the same
 * shared token estimate and the same system-prompt accounting.
 *
 * Key correctness points (previously buggy):
 * - Conversation history never stores system messages; the configured system
 *   prompt is injected by the main process on every request. It is therefore
 *   counted exactly once here, not derived from history.
 * - `canTrimOnce` (manual mode) is only offered when a single auto-trim pass
 *   would actually fit, so "trim & send" does not mislead the user.
 */
export function projectContext(
  messages: ProjectionMessage[],
  pendingContent: string,
  settings: AppSettings,
  model: ModelConfig,
  pendingAttachments?: Message['attachments'],
): ContextProjection {
  const inputBudget = model.contextWindow - model.maxOutputTokens - RESERVED_SAFETY_TOKENS
  // The main process injects the configured system prompt on every request,
  // but skips injection when an identical system message already exists in
  // history (see addConfiguredSystemPrompt). Mirror that exactly: count the
  // configured prompt once unless it is already present as a system message.
  const configuredSystemPrompt = settings.systemPrompt.trim()
  const systemMessages = messages.filter((message) => message.role === 'system')
  const promptAlreadyInHistory = configuredSystemPrompt
    ? systemMessages.some((message) => message.content.trim() === configuredSystemPrompt)
    : false
  const systemCost =
    (configuredSystemPrompt && !promptAlreadyInHistory
      ? estimateMessageTokens({ content: configuredSystemPrompt })
      : 0) + systemMessages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)

  const turns: ProjectionMessage[][] = []
  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'user') turns.push([message])
    else if (turns.length > 0) turns.at(-1)?.push(message)
  }
  const normalizedPendingContent = normalizeMessageContent(pendingContent)
  if (normalizedPendingContent.trim() || pendingAttachments?.length) {
    turns.push([
      {
        role: 'user',
        content: normalizedPendingContent,
        attachments: pendingAttachments,
      },
    ])
  }

  const turnCosts = turns.map((turn) => turn.reduce((sum, message) => sum + estimateMessageTokens(message), 0))
  const estimatedInputTokens = REQUEST_OVERHEAD + systemCost + turnCosts.reduce((sum, cost) => sum + cost, 0)
  const latestTurnCost = turnCosts.at(-1) ?? 0
  const minimumRequired = REQUEST_OVERHEAD + systemCost + latestTurnCost
  const irreducibleOverflow = inputBudget <= REQUEST_OVERHEAD || minimumRequired > inputBudget

  if (irreducibleOverflow) {
    return {
      estimatedInputTokens,
      inputBudget: Math.max(inputBudget, 0),
      blocked: true,
      canTrimOnce: false,
      trimTurnCount: 0,
      tone: 'error',
      message: t(
        'The system prompt and latest question exceed the available context. Shorten them or increase the model’s context window.',
      ),
    }
  }

  if (estimatedInputTokens <= inputBudget) {
    return {
      estimatedInputTokens,
      inputBudget,
      blocked: false,
      canTrimOnce: false,
      trimTurnCount: 0,
      tone: 'ok',
      message: '',
    }
  }

  if (settings.contextManagementMode === 'manual') {
    // We only reach here when the latest turn fits the minimum (otherwise the
    // irreducible branch above returns). Since trimming removes only older
    // turns and keeps system + latest, a single auto-trim pass is guaranteed to
    // fit — so "trim once" is always safe to offer. Compute the exact number of
    // turns that would be dropped so the hint is accurate.
    let retained = estimatedInputTokens
    let trimCount = 0
    while (retained > inputBudget && trimCount < Math.max(turnCosts.length - 1, 0)) {
      retained -= turnCosts[trimCount] ?? 0
      trimCount += 1
    }
    const overflow = estimatedInputTokens - inputBudget
    return {
      estimatedInputTokens,
      inputBudget,
      blocked: true,
      canTrimOnce: true,
      trimTurnCount: trimCount,
      tone: 'error',
      message: t(
        'The input exceeds the available context by approximately {value0} tokens. Manual mode never removes history automatically; you can trim complete turns for this request only.',
        { value0: overflow.toLocaleString(getLanguage()) },
      ),
    }
  }

  let retainedTokens = estimatedInputTokens
  let trimTurnCount = 0
  while (retainedTokens > inputBudget && trimTurnCount < Math.max(turnCosts.length - 1, 0)) {
    retainedTokens -= turnCosts[trimTurnCount] ?? 0
    trimTurnCount += 1
  }
  return {
    estimatedInputTokens,
    inputBudget,
    blocked: false,
    canTrimOnce: false,
    trimTurnCount,
    tone: 'warning',
    message: t(
      'When sent, approximately {value0} complete conversation turns will be trimmed from the oldest history; the latest question will be kept.',
      { value0: trimTurnCount },
    ),
  }
}
