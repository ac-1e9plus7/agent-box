import type { Message } from './types'

/**
 * Token-estimation constants shared by the main-process context preparation
 * and the renderer context projection. Keeping them in one place prevents the
 * two layers from drifting (CLAUDE.md: avoid duplicating protocol logic between
 * renderer and main).
 */
export const PER_MESSAGE_OVERHEAD = 8
export const REQUEST_OVERHEAD = 64
export const RESERVED_SAFETY_TOKENS = 128

// Characters in the basic Latin + Latin Extended block (U+0000..U+024F) pool at
// ~4 chars/token; everything else (notably CJK) counts as ~1 token each.
// eslint-disable-next-line no-control-regex -- the range intentionally includes ASCII control characters
const NARROW_CHARACTER = new RegExp('[\\u0000-\\u024f]', 'u')

/** A dependency-free, deliberately conservative token estimate. */
export function estimateTextTokens(text: string): number {
  let cjkAndWideCharacters = 0
  let otherCharacters = 0

  for (const character of text) {
    if (NARROW_CHARACTER.test(character)) otherCharacters += character.length
    else cjkAndWideCharacters += 1
  }

  return cjkAndWideCharacters + Math.ceil(otherCharacters / 4)
}

/**
 * Estimates the on-the-wire token cost of a message. `reasoning` is never sent
 * to the provider, so it is intentionally excluded from the estimate.
 */
export function estimateMessageTokens(
  message: Pick<Message, 'content'> & {
    attachments?: Message['attachments']
    toolExecutions?: Message['toolExecutions']
    agentTrace?: Message['agentTrace']
  },
): number {
  let total = PER_MESSAGE_OVERHEAD + estimateTextTokens(message.content)
  if (message.attachments?.length) {
    for (const attachment of message.attachments) {
      if (attachment.type === 'image') {
        total += 1000
      } else if (attachment.type === 'text') {
        total += estimateTextTokens(attachment.data) + 16
      } else if (attachment.type === 'document') {
        total += Math.ceil(attachment.data.length / 8) + 100
      }
    }
  }
  if (message.agentTrace?.length) {
    for (const item of message.agentTrace) {
      // assistant_text is already represented by message.content.
      if (item.type === 'assistant_text') continue
      if (item.type === 'assistant_thinking') {
        total += estimateTextTokens(item.thinking) + estimateTextTokens(item.signature || '') + 12
      } else if (item.type === 'provider_item') {
        total += estimateTextTokens(safeJson(item.item)) + 12
      } else if (item.type === 'tool_call') {
        total += estimateTextTokens(item.modelToolName) + estimateTextTokens(safeJson(item.args)) + 16
      } else {
        total += estimateTextTokens(item.result) + estimateTextTokens(safeJson(item.structuredResult)) + 16
        for (const content of item.resultContent || []) {
          if (content.type === 'image') total += 1_000
          else if (content.type === 'audio') total += 2_000
        }
      }
    }
  } else if (message.toolExecutions?.length) {
    for (const execution of message.toolExecutions) {
      total += estimateTextTokens(execution.modelToolName || execution.toolName)
      total += estimateTextTokens(safeJson(execution.args))
      total += estimateTextTokens(execution.result || '') + 16
    }
  }
  return total
}

function safeJson(value: unknown): string {
  if (value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}
