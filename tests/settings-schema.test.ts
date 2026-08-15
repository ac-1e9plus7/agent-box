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
