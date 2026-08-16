import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let mockEncryptionAvailable = true
let mockStorageBackend: string | undefined = undefined

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => mockEncryptionAvailable,
    getSelectedStorageBackend: () => mockStorageBackend,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8'),
  },
}))

const { AppRepository } = await import('../src/electron/storage/app-repository')

describe('Legacy Vault Smooth Migration (ChatBox Lite -> AgentBox)', () => {
  let rootTempDir: string
  let legacyUserDir: string
  let newAgentBoxUserDir: string

  beforeEach(() => {
    mockEncryptionAvailable = true
    mockStorageBackend = undefined
    rootTempDir = mkdtempSync(join(tmpdir(), 'agentbox-migration-root-'))
    legacyUserDir = join(rootTempDir, 'ChatBox Lite')
    newAgentBoxUserDir = join(rootTempDir, 'AgentBox')
  })

  afterEach(() => {
    rmSync(rootTempDir, { recursive: true, force: true })
  })

  it('smoothly migrates historical models, providers and conversations when AgentBox is initialized for the first time', async () => {
    // 1. Setup legacy repository in legacyUserDir with custom models & conversations
    const legacyRepo = new AppRepository(legacyUserDir)
    await legacyRepo.initialize()

    const customProvider = await legacyRepo.upsertProvider({
      name: 'Custom DeepSeek Provider',
      kind: 'custom',
      baseUrl: 'https://api.deepseek.com/v1',
      apiFormat: 'openai-chat-completions',
      apiKey: 'sk-legacy-test-key-12345',
    })

    const customModel = await legacyRepo.upsertModel({
      name: 'DeepSeek Reasoner (V3)',
      providerId: customProvider.id,
      remoteId: 'deepseek-reasoner',
      apiFormat: 'openai-chat-completions',
      contextWindow: 128000,
      maxOutputTokens: 8192,
      supportsReasoning: true,
      defaultReasoningEnabled: true,
      defaultReasoningEffort: 'high',
    })

    const conversation = await legacyRepo.saveConversation({
      id: 'conv-legacy-1',
      title: '历史深度研究对话',
      modelId: customModel.id,
      messages: [
        { id: 'm1', role: 'user', content: '分析量子纠缠原理', createdAt: new Date().toISOString() },
        { id: 'm2', role: 'assistant', content: '量子纠缠是量子力学核心现象...', createdAt: new Date().toISOString() },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    legacyRepo.destroy()

    // 2. Initialize AgentBox repository in newAgentBoxUserDir (which shares parent directory)
    const agentBoxRepo = new AppRepository(newAgentBoxUserDir)
    await agentBoxRepo.initialize()

    // 3. Verify all legacy models, providers, and conversations were automatically restored
    const providers = agentBoxRepo.listProviders()
    const models = agentBoxRepo.listModels()
    const conversations = agentBoxRepo.listConversations()

    expect(providers.some((p) => p.name === 'Custom DeepSeek Provider')).toBe(true)
    const migratedProvider = providers.find((p) => p.name === 'Custom DeepSeek Provider')!
    expect(migratedProvider.hasApiKey).toBe(true)

    expect(models.some((m) => m.name === 'DeepSeek Reasoner (V3)')).toBe(true)
    const migratedModel = models.find((m) => m.name === 'DeepSeek Reasoner (V3)')!
    expect(migratedModel.remoteId).toBe('deepseek-reasoner')
    expect(migratedModel.supportsReasoning).toBe(true)

    expect(conversations.some((c) => c.title === '历史深度研究对话')).toBe(true)
    const migratedConv = agentBoxRepo.getConversation(conversation.id)
    expect(migratedConv?.messages.length).toBe(2)
    expect(migratedConv?.messages[0]?.content).toBe('分析量子纠缠原理')

    agentBoxRepo.destroy()
  })

  it('migrates legacy data even if a fresh empty default vault was already created in AgentBox', async () => {
    // 1. Setup legacy repository with configured model
    const legacyRepo = new AppRepository(legacyUserDir)
    await legacyRepo.initialize()
    await legacyRepo.upsertModel({
      name: 'Legacy Claude Sonnet 4',
      providerId: 'openrouter',
      remoteId: 'anthropic/claude-3.7-sonnet',
      apiFormat: 'anthropic-messages',
      contextWindow: 200000,
      maxOutputTokens: 8192,
      supportsReasoning: true,
      defaultReasoningEnabled: false,
      defaultReasoningEffort: 'medium',
      anthropicThinkingMode: 'manual',
    })
    legacyRepo.destroy()

    // 2. Simulate empty default vault creation in AgentBox
    const emptyAgentBoxStore = new AppRepository(newAgentBoxUserDir)
    await emptyAgentBoxStore.initialize()
    emptyAgentBoxStore.destroy()

    // 3. Re-initialize AgentBox - it should recognize the empty state and migrate legacy data
    const agentBoxRepo = new AppRepository(newAgentBoxUserDir)
    await agentBoxRepo.initialize()

    const models = agentBoxRepo.listModels()
    expect(models.some((m) => m.name === 'Legacy Claude Sonnet 4')).toBe(true)
    agentBoxRepo.destroy()
  })
})
