import { describe, expect, it } from 'vitest'
import { projectContext, type ProjectionMessage } from '../src/renderer/src/context-projection'
import type { AppSettings, ModelConfig } from '../src/shared/types'

const baseSettings: AppSettings = {
  theme: 'system',
  sendShortcut: 'enter',
  contextManagementMode: 'manual',
  defaultReasoningEnabled: false,
  defaultReasoningEffort: 'medium',
  systemPrompt: '',
  proxy: { mode: 'off', url: '' },
  integratedTerminalShell: { mode: 'auto', executable: '', args: [] },
  toolApprovalTimeoutMode: 'five-minutes',
  developerRuntimes: {
    jdk: { mode: 'auto', home: '' },
    go: { mode: 'auto', executable: '', root: '' },
    php: { mode: 'auto', executable: '' },
    python: { mode: 'auto', executable: '', environment: '', condaExecutable: 'conda' },
  },
  defaultWorkingDirectory: '',
}

function model(over: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id: 'm',
    name: 'M',
    providerId: 'p',
    remoteId: 'r',
    contextWindow: 10_000,
    maxOutputTokens: 1_000,
    supportsReasoning: false,
    defaultReasoningEnabled: false,
    defaultReasoningEffort: 'medium',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

function msg(id: string, role: ProjectionMessage['role'], content: string): ProjectionMessage & { id: string } {
  return { id, role, content }
}

describe('projectContext system prompt accounting', () => {
  it('does not count display-only nickname or avatar as prompt content', () => {
    const messages = [msg('u1', 'user', 'hello')]
    const withoutProfile = projectContext(messages, '', baseSettings, model())
    const withProfile = projectContext(messages, '', {
      ...baseSettings,
      userNickname: '只用于展示的昵称',
      userAvatar: 'data:image/webp;base64,UklGRg==',
    }, model())
    expect(withProfile.estimatedInputTokens).toBe(withoutProfile.estimatedInputTokens)
  })

  it('counts the configured system prompt exactly once even though history has no system messages', () => {
    const withoutPrompt = projectContext(
      [msg('u1', 'user', 'hello'), msg('a1', 'assistant', 'hi')],
      '',
      baseSettings,
      model(),
    )
    const withPrompt = projectContext(
      [msg('u1', 'user', 'hello'), msg('a1', 'assistant', 'hi')],
      '',
      { ...baseSettings, systemPrompt: 'You are a helpful assistant.' },
      model(),
    )
    expect(withPrompt.estimatedInputTokens).toBeGreaterThan(withoutPrompt.estimatedInputTokens)
    // Adds exactly one message-worth (overhead 8 + prompt tokens), never double.
    const promptOnly = projectContext([], '', {
      ...baseSettings,
      systemPrompt: 'You are a helpful assistant.',
    }, model())
    const empty = projectContext([], '', baseSettings, model())
    expect(promptOnly.estimatedInputTokens - empty.estimatedInputTokens).toBe(
      withPrompt.estimatedInputTokens - withoutPrompt.estimatedInputTokens,
    )
  })

  it('does not double-count a system prompt that also lives in history', () => {
    const promptText = 'You are a helpful assistant.'
    const explicit = projectContext(
      [msg('s1', 'system', promptText), msg('u1', 'user', 'hello')],
      '',
      { ...baseSettings, systemPrompt: promptText },
      model(),
    )
    const onlyExplicit = projectContext(
      [msg('s1', 'system', promptText), msg('u1', 'user', 'hello')],
      '',
      baseSettings,
      model(),
    )
    // When the explicit system message already matches the configured prompt,
    // the projection must not add a second copy on top.
    expect(explicit.estimatedInputTokens).toBe(onlyExplicit.estimatedInputTokens)
  })
})

describe('projectContext canTrimOnce (manual mode)', () => {
  it('offers trim-once and reports the trimmed turn count', () => {
    // contextWindow 1500, maxOutput 200, safety 128 -> budget 1172.
    // Two old turns (each 1600 latin chars ~= (8+400)*2 = 816) overflow, but
    // trimming both leaves only the latest user, which fits.
    const m = model({ contextWindow: 1500, maxOutputTokens: 200 })
    const messages = [
      msg('u1', 'user', 'a'.repeat(1600)),
      msg('a1', 'assistant', 'b'.repeat(1600)),
      msg('u2', 'user', 'a'.repeat(1600)),
      msg('a2', 'assistant', 'b'.repeat(1600)),
      msg('u3', 'user', 'latest question'),
    ]
    const result = projectContext(messages, '', baseSettings, m)
    expect(result.blocked).toBe(true)
    expect(result.canTrimOnce).toBe(true)
    expect(result.trimTurnCount).toBeGreaterThan(0)
  })

  it('does not offer trim-once when the latest message alone overflows (irreducible)', () => {
    const m = model({ contextWindow: 400, maxOutputTokens: 100 })
    const messages = [
      msg('u1', 'user', 'a'.repeat(800)),
      msg('a1', 'assistant', 'b'.repeat(800)),
      msg('u2', 'user', 'c'.repeat(800)),
    ]
    const result = projectContext(messages, '', baseSettings, m)
    expect(result.blocked).toBe(true)
    expect(result.canTrimOnce).toBe(false)
    expect(result.message).toContain('系统提示词与最新问题已超过可用上下文')
  })
})

describe('projectContext includes pending draft', () => {
  it('adds the pending draft as a preview turn', () => {
    const without = projectContext([msg('u1', 'user', 'hi')], '', baseSettings, model())
    const withDraft = projectContext([msg('u1', 'user', 'hi')], 'follow up question', baseSettings, model())
    expect(withDraft.estimatedInputTokens).toBeGreaterThan(without.estimatedInputTokens)
  })
})
