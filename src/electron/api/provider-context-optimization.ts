import { createHash } from 'node:crypto'
import type {
  AgentProviderContextOptimizationMode,
  ApiFormat,
  Message,
  ProviderContinuation,
  ProviderKind,
} from '../../shared/types'
import { isValidProviderContinuation } from '../../shared/provider-context'

export type ProviderContextStrategy = 'stateless' | 'prefix-cache' | 'native-continuation'

export interface NativeContinuationTarget extends ProviderContinuation {
  messageId: string
}

export interface ProviderContextCompatibilityError {
  code?: string
  message: string
  status?: number
}

export function resolveProviderContextStrategies(
  mode: AgentProviderContextOptimizationMode,
  format: ApiFormat,
  providerKind: ProviderKind,
): ProviderContextStrategy[] {
  if (mode === 'off') return ['stateless']
  if (mode === 'native-continuation') {
    return format === 'openai-responses'
      ? ['native-continuation', 'prefix-cache', 'stateless']
      : ['prefix-cache', 'stateless']
  }
  if (mode === 'prefix-cache') return ['prefix-cache', 'stateless']

  if (format === 'openai-responses' && providerKind === 'openai') {
    return ['native-continuation', 'prefix-cache', 'stateless']
  }
  if (providerKind === 'openai' || providerKind === 'anthropic' || providerKind === 'openrouter') {
    return ['prefix-cache', 'stateless']
  }
  return ['stateless']
}

export function buildProviderPromptCacheKey(conversationId: string, providerId: string, remoteModelId: string): string {
  return createHash('sha256')
    .update('agentbox-provider-context-v1\0')
    .update(conversationId)
    .update('\0')
    .update(providerId)
    .update('\0')
    .update(remoteModelId)
    .digest('hex')
}

export function findLatestNativeContinuation(
  messages: readonly Message[],
  modelId: string,
): NativeContinuationTarget | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (
      message?.role !== 'assistant' ||
      message.modelId !== modelId ||
      !isValidProviderContinuation(message.providerContinuation)
    ) {
      continue
    }
    return { ...message.providerContinuation, messageId: message.id }
  }
  return undefined
}

export function isProviderContextCompatibilityError(
  error: ProviderContextCompatibilityError,
  strategy: Exclude<ProviderContextStrategy, 'stateless'>,
): boolean {
  if (![400, 404, 409, 422].includes(error.status ?? 0)) return false
  const text = `${error.code || ''} ${error.message}`.toLowerCase()
  const patterns =
    strategy === 'native-continuation'
      ? ['previous_response', 'previous response', 'response_id', 'response id', 'store']
      : ['prompt_cache', 'prompt cache', 'cache_control', 'cache control']
  return patterns.some((pattern) => text.includes(pattern))
}
