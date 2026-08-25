import type { ModelConfig, ProviderConfig, WebSearchMode } from './types'
import { t } from '../../shared/i18n'

export const WEB_SEARCH_MODE_LABELS: Record<WebSearchMode, string> = {
  off: t('Off'),
  auto: t('Automatic web search'),
  native: t('Prefer native web search'),
}

export function isWebSearchAvailable(model?: ModelConfig, provider?: ProviderConfig): boolean {
  if (!model || provider?.kind !== 'openrouter') return false
  const format = model.apiFormat ?? provider.apiFormat
  return format === 'openai-chat-completions' || format === 'openai-responses' || format === 'anthropic-messages'
}

export function effectiveWebSearchMode(
  model: ModelConfig | undefined,
  provider: ProviderConfig | undefined,
  requested: WebSearchMode | undefined,
): WebSearchMode {
  return isWebSearchAvailable(model, provider) ? (requested ?? 'off') : 'off'
}
