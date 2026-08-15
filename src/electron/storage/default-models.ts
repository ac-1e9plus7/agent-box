import type { ModelConfig } from '../../shared/types'

/**
 * Builds the OpenRouter Auto model included in newly created vaults.
 *
 * Existing stored models are intentionally not rewritten when these defaults
 * change: without an explicit preset revision, an old value may be a user's
 * deliberate configuration.
 */
export function createOpenRouterAutoModel(timestamp: string): ModelConfig {
  return {
    id: 'openrouter-auto',
    name: 'OpenRouter Auto',
    providerId: 'openrouter',
    remoteId: 'openrouter/auto',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsReasoning: false,
    defaultReasoningEnabled: false,
    defaultReasoningEffort: 'medium',
    defaultWebSearchMode: 'off',
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}
