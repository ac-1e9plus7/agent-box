import type { AppSettings, ProxyConfig, ProxyMode } from '../../shared/types'
import { isLoopbackUrl } from '../api/provider-policy'

/**
 * Validates settings and fills fields introduced after vault schema v1.
 * Missing contextManagementMode is intentionally migrated to the safe,
 * non-destructive manual behavior.
 */
export function normalizeAppSettings(value: unknown): AppSettings {
  if (!isRecord(value)) throw new Error('Invalid settings')
  if (!['system', 'light', 'dark'].includes(String(value.theme))) {
    throw new Error('Invalid theme')
  }
  if (!['enter', 'mod-enter'].includes(String(value.sendShortcut))) {
    throw new Error('Invalid send shortcut')
  }
  const contextManagementMode = value.contextManagementMode ?? 'manual'
  if (!['manual', 'auto'].includes(String(contextManagementMode))) {
    throw new Error('Invalid context management mode')
  }
  if (typeof value.defaultReasoningEnabled !== 'boolean') {
    throw new Error('Invalid reasoning setting')
  }
  if (
    !['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(
      String(value.defaultReasoningEffort),
    )
  ) {
    throw new Error('Invalid reasoning effort')
  }
  if (typeof value.systemPrompt !== 'string' || value.systemPrompt.length > 100_000) {
    throw new Error('Invalid system prompt')
  }
  if (value.defaultModelId !== undefined && typeof value.defaultModelId !== 'string') {
    throw new Error('Invalid default model')
  }
  if (value.titleGenerationModelId !== undefined && typeof value.titleGenerationModelId !== 'string') {
    throw new Error('Invalid title generation model')
  }
  if (value.defaultAgentMode !== undefined && typeof value.defaultAgentMode !== 'boolean') {
    throw new Error('Invalid default agent mode')
  }
  const proxy = normalizeProxy(value.proxy)
  return {
    theme: value.theme as AppSettings['theme'],
    sendShortcut: value.sendShortcut as AppSettings['sendShortcut'],
    contextManagementMode:
      contextManagementMode as AppSettings['contextManagementMode'],
    defaultModelId: value.defaultModelId as string | undefined,
    titleGenerationModelId: value.titleGenerationModelId as string | undefined,
    defaultReasoningEnabled: value.defaultReasoningEnabled,
    defaultReasoningEffort:
      value.defaultReasoningEffort as AppSettings['defaultReasoningEffort'],
    defaultAgentMode: Boolean(value.defaultAgentMode),
    systemPrompt: value.systemPrompt,
    proxy,
  }
}

/**
 * Proxy config is filled with a safe disabled default for older vaults that
 * predate the field. Only `custom` mode enforces a valid URL; `off` keeps any
 * stored URL verbatim so toggling the setting does not lose user input.
 */
function normalizeProxy(value: unknown): ProxyConfig {
  if (value === undefined || value === null) return { mode: 'off', url: '' }
  if (!isRecord(value)) throw new Error('Invalid proxy')
  const mode = value.mode === undefined ? 'off' : String(value.mode)
  if (mode !== 'off' && mode !== 'custom') throw new Error('Invalid proxy mode')
  if (typeof value.url !== 'string') throw new Error('Invalid proxy URL')
  if (value.url.length > 2_000) throw new Error('Invalid proxy URL')
  if (mode === 'custom') validateProxyUrl(value.url)
  return { mode: mode as ProxyMode, url: value.url }
}

function validateProxyUrl(url: string): void {
  if (!url.trim()) throw new Error('代理地址不能为空。')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('代理地址格式无效。')
  }
  const scheme = parsed.protocol.toLowerCase()
  if (scheme !== 'http:' && scheme !== 'https:') {
    throw new Error('代理地址仅支持 http 与 https 协议。')
  }
  // Remote HTTP proxies would transmit requests in the clear; require HTTPS for
  // non-loopback hosts, mirroring the provider base-URL policy.
  if (scheme === 'http:' && !isLoopbackUrl(url)) {
    throw new Error('远程 HTTP 代理不被允许，请使用 https 代理。')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
