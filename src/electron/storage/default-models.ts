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
    // Secure-by-default routing: refuse endpoints that retain user data, and
    // require Zero Data Retention endpoints. Only applied to newly created
    // vaults; existing models keep their stored configuration.
    providerRouting: {
      dataCollection: 'deny',
      zdr: true,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}
