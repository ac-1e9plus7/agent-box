import type { ApiFormat, ProviderKind } from '../../shared/types'

export interface ProviderPolicyInput {
  kind: ProviderKind
  baseUrl: string
  apiKey?: string
  defaultHeaders?: Record<string, string>
}

export function isLoopbackUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (hostname === 'localhost' || hostname === '::1') return true
    const octets = hostname.split('.')
    return (
      octets.length === 4 &&
      octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255) &&
      Number(octets[0]) === 127
    )
  } catch {
    return false
  }
}

export function isApiKeyOptional(
  provider: Pick<ProviderPolicyInput, 'kind' | 'baseUrl'>,
): boolean {
  return provider.kind === 'cliproxy' && isLoopbackUrl(provider.baseUrl)
}

export function providerHasUsableAuthentication(provider: ProviderPolicyInput): boolean {
  return Boolean(provider.apiKey) || isApiKeyOptional(provider)
}

/** Builds auth headers without ever emitting an empty credential header. */
export function buildProviderHeaders(
  provider: ProviderPolicyInput,
  effectiveFormat: ApiFormat,
  includeContentType = true,
): Record<string, string> {
  const headers: Record<string, string> = { ...(provider.defaultHeaders ?? {}) }
  if (includeContentType) headers['Content-Type'] = 'application/json'

  if (effectiveFormat === 'anthropic-messages') {
    headers['anthropic-version'] = '2023-06-01'
    if (provider.apiKey) {
      if (provider.kind === 'openrouter') {
        headers.Authorization = `Bearer ${provider.apiKey}`
      } else {
        headers['x-api-key'] = provider.apiKey
      }
    }
  } else if (provider.apiKey) {
    headers.Authorization = `Bearer ${provider.apiKey}`
  }

  return headers
}
