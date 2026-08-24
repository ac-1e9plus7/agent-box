import type { ApiFormat } from '../../shared/types'
import { API_FORMAT_LABELS } from './types'
import { t } from "../../shared/i18n"

export const DEFAULT_NEW_PROVIDER_API_FORMAT: ApiFormat = 'openai-responses'

export const LEGACY_CHAT_COMPLETIONS_HINT =
  t("The Chat Completions API remains supported, but OpenAI recommends the Responses API for all new projects. Choose this format only when a compatible provider has not implemented `/v1/responses`.")

export function providerApiFormatOptionLabel(format: ApiFormat): string {
  return format === 'openai-chat-completions'
    ? t("{value0} (supported; Responses API recommended)", { value0: API_FORMAT_LABELS[format] })
    : API_FORMAT_LABELS[format]
}
