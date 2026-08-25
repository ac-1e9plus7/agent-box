/**
 * Converts platform-specific line endings to the canonical message format.
 *
 * Message content is source data: callers may use `trim()` to decide whether
 * it is empty, but must not store or send the trimmed value. Rendering is a
 * separate concern and must never be converted back into message content.
 */
export function normalizeMessageContent(content: string): string {
  return content.replace(/\r\n?/g, '\n')
}
