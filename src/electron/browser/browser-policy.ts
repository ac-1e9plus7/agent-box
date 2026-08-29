import { isIP } from 'node:net'
import type { Session } from 'electron'
import { BrowserError } from './browser-errors'
import { t } from '../../shared/i18n'

const SENSITIVE_QUERY_KEY = /(?:^|[_-])(token|code|auth|session|key|password|passwd|signature|secret)(?:$|[_-])/i

export interface BrowserUrlPolicyOptions {
  allowHttpLoopback: boolean
}

export function normalizeBrowserUrl(value: string, options: BrowserUrlPolicyOptions): URL {
  if (typeof value !== 'string' || !value.trim() || value.length > 4_096 || /[\0\r\n]/.test(value)) {
    throw new BrowserError(t('The browser URL is invalid.'), 'invalid_url')
  }
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new BrowserError(t('The browser URL is invalid.'), 'invalid_url')
  }
  if (url.username || url.password) {
    throw new BrowserError(t('Browser URLs cannot contain usernames or passwords.'), 'blocked_url')
  }
  const loopback = isLoopbackHostname(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && options.allowHttpLoopback && loopback)) {
    throw new BrowserError(
      options.allowHttpLoopback
        ? t('The built-in browser allows HTTPS and explicitly enabled loopback HTTP URLs only.')
        : t('The built-in browser allows HTTPS URLs only.'),
      'blocked_url',
    )
  }
  if (isPrivateHostname(url.hostname) && !(options.allowHttpLoopback && loopback)) {
    throw new BrowserError(t('The built-in browser blocks private and local network addresses.'), 'blocked_url')
  }
  return url
}

export function isAllowedBrowserSubresource(value: string, options: BrowserUrlPolicyOptions): boolean {
  try {
    const url = new URL(value)
    if (url.protocol === 'blob:' || url.protocol === 'data:') return true
    normalizeBrowserUrl(url.toString(), options)
    return true
  } catch {
    return false
  }
}

export async function assertPublicBrowserDestination(
  target: URL,
  browserSession: Session,
  options: BrowserUrlPolicyOptions,
): Promise<void> {
  if (options.allowHttpLoopback && isLoopbackHostname(target.hostname)) return
  if (isIP(stripIpv6Brackets(target.hostname))) {
    if (isPrivateIpAddress(stripIpv6Brackets(target.hostname))) {
      throw new BrowserError(t('The built-in browser blocks private and local network addresses.'), 'blocked_url')
    }
    return
  }
  let resolved: Awaited<ReturnType<Session['resolveHost']>>
  try {
    resolved = await browserSession.resolveHost(target.hostname, { cacheUsage: 'disallowed' })
  } catch {
    throw new BrowserError(t('The browser destination could not be resolved.'), 'navigation_failed')
  }
  if (!resolved.endpoints.length || resolved.endpoints.some((endpoint) => isPrivateIpAddress(endpoint.address))) {
    throw new BrowserError(t('The built-in browser blocks private and local network addresses.'), 'blocked_url')
  }
}

export function redactBrowserUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.hash = ''
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, '***')
    }
    return url.toString()
  } catch {
    return t('(invalid URL)')
  }
}

export function browserOrigin(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : undefined
  } catch {
    return undefined
  }
}

export function isPrivateIpAddress(value: string): boolean {
  const normalized = stripIpv6Brackets(value).toLowerCase()
  const kind = isIP(normalized)
  if (kind === 4) {
    const octets = normalized.split('.').map(Number)
    const first = octets[0] ?? -1
    const second = octets[1] ?? -1
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      first >= 224
    )
  }
  if (kind === 6) {
    if (normalized === '::' || normalized === '::1') return true
    if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('ff')) return true
    if (/^fe[89ab]/.test(normalized)) return true
    const mapped = /(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1]
    return mapped ? isPrivateIpAddress(mapped) : false
  }
  return true
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = stripIpv6Brackets(hostname).toLowerCase()
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '::1') return true
  if (isIP(normalized) !== 4) return false
  return Number(normalized.split('.')[0]) === 127
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = stripIpv6Brackets(hostname).toLowerCase()
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) return true
  return isIP(normalized) > 0 && isPrivateIpAddress(normalized)
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
}
