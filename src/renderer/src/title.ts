import type { Message } from '../../shared/types'
import { t } from "../../shared/i18n"

/** Maximum length for a generated or manual conversation title. */
export const MAX_TITLE_LENGTH = 100

/**
 * System prompt asking the model for a concise title. The model is told to
 * output only the title with no explanation, quotes, or surrounding prose so
 * the raw text can be cleaned into a displayable title.
 */
export const TITLE_SYSTEM_PROMPT =
  t("You generate concise conversation titles from user messages. Keep each title under 12 words.") +
  t("Output only the title itself, without quotes, explanations, punctuation prefixes, or line breaks.")

/**
 * The user question that will be turned into a title. Empty messages, system
 * messages, and assistant messages are skipped; the first user message wins.
 */
export function firstUserQuestion(messages: { role: Message['role']; content: string; attachments?: Message['attachments'] }[]): string {
  const first = messages.find((message) => message.role === 'user' && (message.content.trim() || message.attachments?.length))
  if (!first) return ''
  if (first.content.trim()) return first.content.trim()
  return first.attachments?.[0]?.name ? t("[File] {value0}", { value0: first.attachments[0].name }) : ''
}

/**
 * Cleans a model-generated title into a displayable string: strips surrounding
 * quotes/whitespace/newlines and trims to a reasonable length. Returns
 * `undefined` when nothing usable remains, so callers can fall back to the
 * existing truncated-title behavior.
 */
export function cleanGeneratedTitle(raw: string): string | undefined {
  let title = raw.replace(/\s+/g, ' ').trim()
  // Strip a single layer of matching surrounding quotes (Chinese or ASCII).
  if (
    (title.startsWith('“') && title.endsWith('”')) ||
    (title.startsWith('"') && title.endsWith('"')) ||
    (title.startsWith('‘') && title.endsWith('’')) ||
    (title.startsWith("'") && title.endsWith("'"))
  ) {
    title = title.slice(1, -1).trim()
  }
  // Drop a trailing period/punctuation that models sometimes append.
  title = title.replace(/[。.!?！？]+$/u, '').trim()
  if (!title) return undefined
  return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH)}…` : title
}

/** Cleans a manually-entered title. Returns undefined for empty input. */
export function cleanManualTitle(raw: string): string | undefined {
  const title = raw.replace(/\s+/g, ' ').trim()
  if (!title) return undefined
  return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH)}…` : title
}
