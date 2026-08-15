import { describe, expect, it } from 'vitest'
import { normalizeAppSettings } from '../src/electron/storage/settings-schema'

const legacySettings = {
  theme: 'system',
  sendShortcut: 'enter',
  defaultModelId: 'openrouter-auto',
  defaultReasoningEnabled: false,
  defaultReasoningEffort: 'medium',
  systemPrompt: '',
}

describe('settings schema migration', () => {
  it('migrates legacy vault settings to manual context management', () => {
    expect(normalizeAppSettings(legacySettings).contextManagementMode).toBe('manual')
  })

  it('preserves an explicit auto mode', () => {
    expect(
      normalizeAppSettings({
        ...legacySettings,
        contextManagementMode: 'auto',
      }).contextManagementMode,
    ).toBe('auto')
  })

  it('rejects unknown context management modes', () => {
    expect(() =>
      normalizeAppSettings({
        ...legacySettings,
        contextManagementMode: 'truncate-everything',
      }),
    ).toThrow('Invalid context management mode')
  })
})

describe('proxy settings', () => {
  it('defaults to a disabled proxy for legacy vaults missing the field', () => {
    expect(normalizeAppSettings(legacySettings).proxy).toEqual({ mode: 'off', url: '' })
  })

  it('accepts a loopback http proxy in custom mode', () => {
    const result = normalizeAppSettings({
      ...legacySettings,
      proxy: { mode: 'custom', url: 'http://127.0.0.1:7890' },
    })
    expect(result.proxy).toEqual({ mode: 'custom', url: 'http://127.0.0.1:7890' })
  })

  it('accepts a remote https proxy with embedded credentials', () => {
    const result = normalizeAppSettings({
      ...legacySettings,
      proxy: { mode: 'custom', url: 'https://user:pass@proxy.example.com:443' },
    })
    expect(result.proxy.mode).toBe('custom')
    expect(result.proxy.url).toBe('https://user:pass@proxy.example.com:443')
  })

  it('preserves a stored url when the proxy is disabled', () => {
    const result = normalizeAppSettings({
      ...legacySettings,
      proxy: { mode: 'off', url: 'http://127.0.0.1:7890' },
    })
    expect(result.proxy).toEqual({ mode: 'off', url: 'http://127.0.0.1:7890' })
  })

  it('rejects an empty url in custom mode', () => {
    expect(() =>
      normalizeAppSettings({ ...legacySettings, proxy: { mode: 'custom', url: '' } }),
    ).toThrow('代理地址不能为空')
  })

  it('rejects a remote http proxy', () => {
    expect(() =>
      normalizeAppSettings({
        ...legacySettings,
        proxy: { mode: 'custom', url: 'http://proxy.example.com:8080' },
      }),
    ).toThrow('远程 HTTP 代理不被允许')
  })

  it('rejects unsupported proxy schemes', () => {
    expect(() =>
      normalizeAppSettings({
        ...legacySettings,
        proxy: { mode: 'custom', url: 'socks5://127.0.0.1:1080' },
      }),
    ).toThrow('代理地址仅支持 http 与 https 协议')
  })

  it('rejects a malformed proxy url', () => {
    expect(() =>
      normalizeAppSettings({ ...legacySettings, proxy: { mode: 'custom', url: 'not a url' } }),
    ).toThrow('代理地址格式无效')
  })

  it('rejects an unknown proxy mode', () => {
    expect(() =>
      normalizeAppSettings({ ...legacySettings, proxy: { mode: 'system', url: '' } }),
    ).toThrow('Invalid proxy mode')
  })

  it('rejects a non-object proxy config', () => {
    expect(() => normalizeAppSettings({ ...legacySettings, proxy: 'http://127.0.0.1' })).toThrow(
      'Invalid proxy',
    )
  })
})
