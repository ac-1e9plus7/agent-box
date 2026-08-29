import { describe, expect, it } from 'vitest'
import { normalizeAppSettings } from '../src/electron/storage/settings-schema'
import { MAX_USER_AVATAR_DATA_URL_LENGTH } from '../src/shared/user-profile'

const legacySettings = {
  theme: 'system',
  sendShortcut: 'enter',
  defaultModelId: 'openrouter-auto',
  defaultReasoningEnabled: false,
  defaultReasoningEffort: 'medium',
  systemPrompt: '',
}

describe('settings schema migration', () => {
  it('uses the caller-provided system language for legacy settings', () => {
    expect(normalizeAppSettings(legacySettings, 'zh-CN').language).toBe('zh-CN')
    expect(normalizeAppSettings(legacySettings, 'en-US').language).toBe('en-US')
  })

  it('preserves a selected language and rejects unknown values', () => {
    expect(normalizeAppSettings({ ...legacySettings, language: 'zh-CN' }).language).toBe('zh-CN')
    expect(() => normalizeAppSettings({ ...legacySettings, language: 'fr-FR' })).toThrow('Invalid language')
  })

  it('defaults legacy settings to an empty display-only user profile', () => {
    expect(normalizeAppSettings(legacySettings)).toMatchObject({
      userNickname: '',
      userAvatar: '',
    })
  })

  it('normalizes a display-only nickname and avatar', () => {
    const avatar = 'data:image/webp;base64,UklGRg=='
    expect(
      normalizeAppSettings({
        ...legacySettings,
        userNickname: '  小明  ',
        userAvatar: avatar,
      }),
    ).toMatchObject({
      userNickname: '小明',
      userAvatar: avatar,
    })
  })

  it('rejects invalid or oversized display profile fields', () => {
    expect(() => normalizeAppSettings({ ...legacySettings, userNickname: 'a'.repeat(51) })).toThrow(
      '昵称不能超过 50 个字符',
    )
    expect(() => normalizeAppSettings({ ...legacySettings, userNickname: '第一行\n第二行' })).toThrow(
      '昵称不能超过 50 个字符',
    )
    expect(() => normalizeAppSettings({ ...legacySettings, userAvatar: 'https://example.com/avatar.png' })).toThrow(
      '头像数据过大或格式无效',
    )
    expect(() =>
      normalizeAppSettings({
        ...legacySettings,
        userAvatar: `data:image/webp;base64,${'A'.repeat(MAX_USER_AVATAR_DATA_URL_LENGTH)}`,
      }),
    ).toThrow('头像数据过大或格式无效')
  })

  it('defaults legacy settings to thirty Agent tool turns', () => {
    expect(normalizeAppSettings(legacySettings).agentToolTurnLimit).toBe(30)
  })

  it('accepts a custom Agent tool turn limit and rejects unsafe values', () => {
    expect(normalizeAppSettings({ ...legacySettings, agentToolTurnLimit: 45 }).agentToolTurnLimit).toBe(45)
    for (const agentToolTurnLimit of [0, 101, 1.5, '30']) {
      expect(() => normalizeAppSettings({ ...legacySettings, agentToolTurnLimit })).toThrow(
        'Agent 工具调用轮次必须是 1-100 之间的整数',
      )
    }
  })

  it('defaults legacy settings to disabled Agent token optimizations and conservative parameters', () => {
    expect(normalizeAppSettings(legacySettings)).toMatchObject({
      agentToolResultCompactionEnabled: false,
      agentToolResultMaxCharacters: 16_000,
      agentDynamicToolExposureEnabled: false,
      agentDynamicToolLimit: 4,
      agentLazySkillResourcesEnabled: false,
      agentContextCompactionEnabled: false,
      agentContextCompactionThresholdPercent: 70,
      agentContextCompactionKeepRecentTurns: 3,
      agentProviderContextOptimizationMode: 'off',
    })
  })

  it('defaults legacy settings to a disabled built-in browser and validates its opt-ins', () => {
    expect(normalizeAppSettings(legacySettings)).toMatchObject({
      builtInBrowserEnabled: false,
      browserAllowHttpLoopback: false,
      browserPersistCookiesEnabled: false,
      browserAgentScreenshotsEnabled: false,
      browserFileUploadsEnabled: false,
      browserDownloadsEnabled: false,
    })
    expect(
      normalizeAppSettings({
        ...legacySettings,
        builtInBrowserEnabled: true,
        browserAllowHttpLoopback: true,
        browserPersistCookiesEnabled: true,
        browserAgentScreenshotsEnabled: true,
        browserFileUploadsEnabled: true,
        browserDownloadsEnabled: true,
      }),
    ).toMatchObject({
      builtInBrowserEnabled: true,
      browserAllowHttpLoopback: true,
      browserPersistCookiesEnabled: true,
      browserAgentScreenshotsEnabled: true,
      browserFileUploadsEnabled: true,
      browserDownloadsEnabled: true,
    })
    expect(() => normalizeAppSettings({ ...legacySettings, builtInBrowserEnabled: 'yes' })).toThrow(
      'Invalid built-in browser',
    )
  })

  it('preserves enabled Agent token optimizations and valid boundary values', () => {
    expect(
      normalizeAppSettings({
        ...legacySettings,
        agentToolResultCompactionEnabled: true,
        agentToolResultMaxCharacters: 100_000,
        agentDynamicToolExposureEnabled: true,
        agentDynamicToolLimit: 1,
        agentLazySkillResourcesEnabled: true,
        agentContextCompactionEnabled: true,
        agentContextCompactionThresholdPercent: 95,
        agentContextCompactionKeepRecentTurns: 10,
        agentProviderContextOptimizationMode: 'native-continuation',
      }),
    ).toMatchObject({
      agentToolResultCompactionEnabled: true,
      agentToolResultMaxCharacters: 100_000,
      agentDynamicToolExposureEnabled: true,
      agentDynamicToolLimit: 1,
      agentLazySkillResourcesEnabled: true,
      agentContextCompactionEnabled: true,
      agentContextCompactionThresholdPercent: 95,
      agentContextCompactionKeepRecentTurns: 10,
      agentProviderContextOptimizationMode: 'native-continuation',
    })
  })

  it('rejects malformed Agent token-optimization switches', () => {
    for (const [field, value] of [
      ['agentToolResultCompactionEnabled', 'true'],
      ['agentDynamicToolExposureEnabled', 1],
      ['agentLazySkillResourcesEnabled', null],
      ['agentContextCompactionEnabled', 'false'],
    ] as const) {
      expect(() => normalizeAppSettings({ ...legacySettings, [field]: value })).toThrow('Invalid Agent')
    }
  })

  it('rejects an unknown provider context optimization mode', () => {
    expect(() =>
      normalizeAppSettings({ ...legacySettings, agentProviderContextOptimizationMode: 'provider-magic' }),
    ).toThrow('Invalid Agent provider context optimization mode')
  })

  it('rejects out-of-range or non-integer Agent token-optimization parameters', () => {
    for (const [field, value] of [
      ['agentToolResultMaxCharacters', 1_999],
      ['agentToolResultMaxCharacters', 100_001],
      ['agentToolResultMaxCharacters', '16000'],
      ['agentDynamicToolLimit', 0],
      ['agentDynamicToolLimit', 17],
      ['agentContextCompactionThresholdPercent', 49],
      ['agentContextCompactionThresholdPercent', 96],
      ['agentContextCompactionKeepRecentTurns', 0],
      ['agentContextCompactionKeepRecentTurns', 11],
      ['agentContextCompactionKeepRecentTurns', 1.5],
    ] as const) {
      expect(() => normalizeAppSettings({ ...legacySettings, [field]: value })).toThrow('Invalid Agent')
    }
  })

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

  it('defaults legacy settings to automatic integrated terminal shell selection', () => {
    expect(normalizeAppSettings(legacySettings).integratedTerminalShell).toEqual({
      mode: 'auto',
      executable: '',
      args: [],
    })
  })

  it('accepts a custom cross-platform shell and argument template', () => {
    expect(
      normalizeAppSettings({
        ...legacySettings,
        integratedTerminalShell: {
          mode: 'custom',
          executable: '/usr/bin/nu',
          args: ['-c', '{command}'],
        },
      }).integratedTerminalShell,
    ).toEqual({
      mode: 'custom',
      executable: '/usr/bin/nu',
      args: ['-c', '{command}'],
    })
  })

  it('rejects an empty custom integrated terminal shell', () => {
    expect(() =>
      normalizeAppSettings({
        ...legacySettings,
        integratedTerminalShell: { mode: 'custom', executable: '', args: [] },
      }),
    ).toThrow('自定义终端 Shell 可执行文件不能为空')
  })

  it('defaults approval waiting to five minutes', () => {
    expect(normalizeAppSettings(legacySettings).toolApprovalTimeoutMode).toBe('five-minutes')
  })

  it('accepts approval waiting without a timeout', () => {
    expect(
      normalizeAppSettings({
        ...legacySettings,
        toolApprovalTimeoutMode: 'never',
      }).toolApprovalTimeoutMode,
    ).toBe('never')
  })

  it('migrates the legacy never-confirm policy to Full Access', () => {
    expect(
      normalizeAppSettings({
        ...legacySettings,
        mcpToolApprovalPolicy: 'never',
      }).mcpToolApprovalPolicy,
    ).toBe('full-access')
  })

  it('preserves an explicit Full Access policy', () => {
    expect(
      normalizeAppSettings({
        ...legacySettings,
        mcpToolApprovalPolicy: 'full-access',
      }).mcpToolApprovalPolicy,
    ).toBe('full-access')
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
    expect(() => normalizeAppSettings({ ...legacySettings, proxy: { mode: 'custom', url: '' } })).toThrow(
      '代理地址不能为空',
    )
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
    expect(() => normalizeAppSettings({ ...legacySettings, proxy: { mode: 'custom', url: 'not a url' } })).toThrow(
      '代理地址格式无效',
    )
  })

  it('rejects an unknown proxy mode', () => {
    expect(() => normalizeAppSettings({ ...legacySettings, proxy: { mode: 'system', url: '' } })).toThrow(
      'Invalid proxy mode',
    )
  })

  it('rejects a non-object proxy config', () => {
    expect(() => normalizeAppSettings({ ...legacySettings, proxy: 'http://127.0.0.1' })).toThrow('Invalid proxy')
  })
})
