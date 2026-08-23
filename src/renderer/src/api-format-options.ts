import type { ApiFormat } from '../../shared/types'
import { API_FORMAT_LABELS } from './types'

export const DEFAULT_NEW_PROVIDER_API_FORMAT: ApiFormat = 'openai-responses'

export const LEGACY_CHAT_COMPLETIONS_HINT =
  'Chat Completions 仍受支持，但 OpenAI 建议所有新项目使用 Responses。仅当兼容服务商尚未实现 /v1/responses 时选择此格式。'

export function providerApiFormatOptionLabel(format: ApiFormat): string {
  return format === 'openai-chat-completions'
    ? `${API_FORMAT_LABELS[format]}（旧版，不推荐）`
    : API_FORMAT_LABELS[format]
}
