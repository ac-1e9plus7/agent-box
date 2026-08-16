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
export function estimateMessageTokens(message: Pick<Message, 'content'> & { attachments?: Message['attachments'] }): number {
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
  return total
}
