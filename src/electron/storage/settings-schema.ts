import type { AppSettings } from '../../shared/types'

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
  return {
    theme: value.theme as AppSettings['theme'],
    sendShortcut: value.sendShortcut as AppSettings['sendShortcut'],
    contextManagementMode:
      contextManagementMode as AppSettings['contextManagementMode'],
    defaultModelId: value.defaultModelId as string | undefined,
    defaultReasoningEnabled: value.defaultReasoningEnabled,
    defaultReasoningEffort:
      value.defaultReasoningEffort as AppSettings['defaultReasoningEffort'],
    systemPrompt: value.systemPrompt,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
