import { randomUUID } from 'node:crypto'
import { parseDataPlatOperations, type DataPlatOperation } from '../mcp/data-plat-state'

import type {
  AppSettings,
  BrowserCookieProfile,
  BrowserCookieRecord,
  Conversation,
  McpServerConfig,
  McpServerInput,
  ModelConfig,
  ModelInput,
  ProviderInput,
  ProviderView,
  Skill,
  SkillInput,
} from '../../shared/types'

import { EncryptedStore } from './encrypted-store'
import { CheckpointRepositoryError, EncryptedCheckpointRepository } from './checkpoint-repository'
import { AgentBoxCheckpointSaver } from './agentbox-checkpoint-saver'
import { agentCheckpointThreadId } from './checkpoint-identity'

import { DEFAULT_SKILLS, localizedDefaultSkills } from './default-skills'
import { normalizeAppSettings } from './settings-schema'

import { assertConversationMutationAllowed } from './vault-resource-limits'
import { parseOptionalWebSearchMode } from './web-metadata-schema'
import { t, type AppLanguage } from '../../shared/i18n'

import {
  MAX_SKILLS,
  MAX_MCP_SERVERS,
  MAX_BROWSER_COOKIE_PROFILES,
  MAX_BROWSER_COOKIE_CHARACTERS,
  buildStoredProvider,
  createDefaultVault,
  validateVault,
  validateModel,
  validateSkill,
  validateMcpServer,
  validateBrowserProfile,
  mergeLocalizedBuiltInSkill,
  validateConversation,
  sanitizeProviderRouting,
  toProviderView,
  resolveMcpInputSecrets,
  maskMcpServerSecrets,
  type StoredProvider,
  type VaultState,
} from './vault-schema'
export type { StoredProvider, VaultState } from './vault-schema'
export { normalizeBaseUrl, sanitizeHeaders, sanitizeMcpHeaders, sanitizeProviderRouting } from './vault-schema'

export class AppRepository {
  private readonly store: EncryptedStore<VaultState>
  private checkpointRepository?: EncryptedCheckpointRepository
  private checkpointSaver?: AgentBoxCheckpointSaver

  constructor(userDataDirectory: string, defaultLanguage: AppLanguage = 'en-US') {
    this.store = new EncryptedStore(
      userDataDirectory,
      () => createDefaultVault(defaultLanguage),
      (value) => validateVault(value, defaultLanguage),
    )
  }

  async initialize(options?: { allowLegacyMigration?: boolean }): Promise<void> {
    await this.store.initialize(options)
    const checkpointRepository = new EncryptedCheckpointRepository(
      this.store.openRecordNamespace('agent-checkpoints-v1'),
    )
    await checkpointRepository.initialize()
    this.checkpointRepository = checkpointRepository
    this.checkpointSaver = new AgentBoxCheckpointSaver(checkpointRepository)
  }

  destroy(): void {
    this.checkpointRepository = undefined
    this.checkpointSaver = undefined
    this.store.destroy()
  }

  async close(): Promise<void> {
    await this.store.close()
    this.checkpointRepository = undefined
    this.checkpointSaver = undefined
  }

  getAgentCheckpointSaver(): AgentBoxCheckpointSaver {
    if (!this.checkpointSaver) throw new Error('Agent checkpoint repository has not been initialized')
    return this.checkpointSaver
  }

  getSettings(): AppSettings {
    return this.store.readField('settings')
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    return this.store.mutate((draft) => {
      const next = { ...draft.settings }
      if (patch.language !== undefined) next.language = patch.language
      if (patch.theme !== undefined) next.theme = patch.theme
      if (patch.sendShortcut !== undefined) next.sendShortcut = patch.sendShortcut
      if (patch.contextManagementMode !== undefined) {
        next.contextManagementMode = patch.contextManagementMode
      }
      if (patch.userNickname !== undefined) next.userNickname = patch.userNickname
      if (patch.userAvatar !== undefined) next.userAvatar = patch.userAvatar
      if (patch.defaultModelId !== undefined) next.defaultModelId = patch.defaultModelId
      if (patch.titleGenerationModelId !== undefined) {
        next.titleGenerationModelId = patch.titleGenerationModelId
      }
      if (patch.defaultReasoningEnabled !== undefined) {
        next.defaultReasoningEnabled = patch.defaultReasoningEnabled
      }
      if (patch.defaultReasoningEffort !== undefined) {
        next.defaultReasoningEffort = patch.defaultReasoningEffort
      }
      if (patch.defaultAgentMode !== undefined) {
        next.defaultAgentMode = patch.defaultAgentMode
      }
      if (patch.agentToolTurnLimit !== undefined) {
        next.agentToolTurnLimit = patch.agentToolTurnLimit
      }
      if (patch.agentToolResultCompactionEnabled !== undefined) {
        next.agentToolResultCompactionEnabled = patch.agentToolResultCompactionEnabled
      }
      if (patch.agentToolResultMaxCharacters !== undefined) {
        next.agentToolResultMaxCharacters = patch.agentToolResultMaxCharacters
      }
      if (patch.agentDynamicToolExposureEnabled !== undefined) {
        next.agentDynamicToolExposureEnabled = patch.agentDynamicToolExposureEnabled
      }
      if (patch.agentDynamicToolLimit !== undefined) {
        next.agentDynamicToolLimit = patch.agentDynamicToolLimit
      }
      if (patch.agentLazySkillResourcesEnabled !== undefined) {
        next.agentLazySkillResourcesEnabled = patch.agentLazySkillResourcesEnabled
      }
      if (patch.agentContextCompactionEnabled !== undefined) {
        next.agentContextCompactionEnabled = patch.agentContextCompactionEnabled
      }
      if (patch.agentContextCompactionThresholdPercent !== undefined) {
        next.agentContextCompactionThresholdPercent = patch.agentContextCompactionThresholdPercent
      }
      if (patch.agentContextCompactionKeepRecentTurns !== undefined) {
        next.agentContextCompactionKeepRecentTurns = patch.agentContextCompactionKeepRecentTurns
      }
      if (patch.agentProviderContextOptimizationMode !== undefined) {
        next.agentProviderContextOptimizationMode = patch.agentProviderContextOptimizationMode
      }
      if (patch.builtInBrowserEnabled !== undefined) {
        next.builtInBrowserEnabled = patch.builtInBrowserEnabled
      }
      if (patch.browserHomePage !== undefined) {
        next.browserHomePage = patch.browserHomePage
      }
      if (patch.browserAllowHttpLoopback !== undefined) {
        next.browserAllowHttpLoopback = patch.browserAllowHttpLoopback
      }
      if (patch.browserPersistCookiesEnabled !== undefined) {
        next.browserPersistCookiesEnabled = patch.browserPersistCookiesEnabled
      }
      if (patch.browserAgentScreenshotsEnabled !== undefined) {
        next.browserAgentScreenshotsEnabled = patch.browserAgentScreenshotsEnabled
      }
      if (patch.browserFileUploadsEnabled !== undefined) {
        next.browserFileUploadsEnabled = patch.browserFileUploadsEnabled
      }
      if (patch.browserDownloadsEnabled !== undefined) {
        next.browserDownloadsEnabled = patch.browserDownloadsEnabled
      }
      if (patch.mcpEnabled !== undefined) next.mcpEnabled = patch.mcpEnabled
      if (patch.mcpToolRetrievalMode !== undefined) {
        next.mcpToolRetrievalMode = patch.mcpToolRetrievalMode
      }
      if (patch.mcpToolApprovalPolicy !== undefined) {
        next.mcpToolApprovalPolicy = patch.mcpToolApprovalPolicy
      }
      if (patch.toolApprovalTimeoutMode !== undefined) {
        next.toolApprovalTimeoutMode = patch.toolApprovalTimeoutMode
      }
      if (patch.systemPrompt !== undefined) next.systemPrompt = patch.systemPrompt
      if (patch.proxy !== undefined) next.proxy = patch.proxy
      if (patch.integratedTerminalShell !== undefined) {
        next.integratedTerminalShell = patch.integratedTerminalShell
      }
      if (patch.defaultWorkingDirectory !== undefined) {
        next.defaultWorkingDirectory = patch.defaultWorkingDirectory
      }
      if (patch.developerRuntimes !== undefined) next.developerRuntimes = patch.developerRuntimes
      draft.settings = normalizeAppSettings(next)
      return structuredClone(draft.settings)
    })
  }

  listProviders(): ProviderView[] {
    return this.store.readField('providers').map(toProviderView)
  }

  getStoredProvider(id: string): StoredProvider | undefined {
    return this.store.readField('providers').find((provider) => provider.id === id)
  }

  buildProviderCandidate(input: ProviderInput): StoredProvider {
    const existing = input.id ? this.getStoredProvider(input.id) : undefined
    return buildStoredProvider(input, existing)
  }

  async upsertProvider(input: ProviderInput): Promise<ProviderView> {
    return this.store.mutate((draft) => {
      const existing = input.id ? draft.providers.find((provider) => provider.id === input.id) : undefined
      const provider = buildStoredProvider(input, existing)

      if (existing) {
        draft.providers = draft.providers.map((item) => (item.id === existing.id ? provider : item))
      } else {
        draft.providers.push(provider)
      }
      return toProviderView(provider)
    })
  }

  async removeProvider(id: string): Promise<void> {
    return this.store.mutate((draft) => {
      if (draft.models.some((model) => model.providerId === id)) {
        throw new Error(t('This provider is still used by one or more models. Remove or migrate those models first.'))
      }
      draft.providers = draft.providers.filter((provider) => provider.id !== id)
    })
  }

  listModels(): ModelConfig[] {
    return this.store.readField('models')
  }

  getModel(id: string): ModelConfig | undefined {
    return this.store.readField('models').find((model) => model.id === id)
  }

  async upsertModel(input: ModelInput): Promise<ModelConfig> {
    return this.store.mutate((draft) => {
      if (!draft.providers.some((provider) => provider.id === input.providerId)) {
        throw new Error(t('The provider referenced by this model no longer exists.'))
      }

      const existing = input.id ? draft.models.find((model) => model.id === input.id) : undefined
      const timestamp = new Date().toISOString()
      const model: ModelConfig = {
        id: existing?.id ?? randomUUID(),
        name: input.name.trim(),
        providerId: input.providerId,
        remoteId: input.remoteId.trim(),
        apiFormat: input.apiFormat,
        contextWindow: Math.trunc(input.contextWindow),
        maxOutputTokens: Math.trunc(input.maxOutputTokens),
        supportsReasoning: input.supportsReasoning,
        defaultReasoningEnabled: input.defaultReasoningEnabled,
        defaultReasoningEffort: input.defaultReasoningEffort,
        defaultWebSearchMode: parseOptionalWebSearchMode(input.defaultWebSearchMode, 'model web search mode'),
        anthropicThinkingMode: input.anthropicThinkingMode,
        providerRouting: sanitizeProviderRouting(input.providerRouting),
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      }
      validateModel(model)

      if (existing) {
        draft.models = draft.models.map((item) => (item.id === existing.id ? model : item))
      } else {
        draft.models.push(model)
      }
      return structuredClone(model)
    })
  }

  async removeModel(id: string): Promise<void> {
    return this.store.mutate((draft) => {
      if (draft.conversations.some((conversation) => conversation.modelId === id)) {
        throw new Error(
          t(
            'This model is still used by one or more conversations. Delete those conversations or switch their model first.',
          ),
        )
      }
      draft.models = draft.models.filter((model) => model.id !== id)
      if (draft.settings.defaultModelId === id) {
        draft.settings.defaultModelId = draft.models[0]?.id
      }
    })
  }

  listSkills(): Skill[] {
    const defaults = localizedDefaultSkills()
    const storedSkills = this.store.readField('skills') ?? defaults
    const skills = storedSkills.map((skill) => {
      if (!skill.isBuiltIn) return skill
      const currentDefault = defaults.find((item) => item.id === skill.id)
      const sourceDefault = DEFAULT_SKILLS.find((item) => item.id === skill.id)
      // Keep user enablement and edited instructions, while allowing built-in
      // resources and trigger metadata to follow the selected display language.
      return currentDefault && sourceDefault ? mergeLocalizedBuiltInSkill(skill, sourceDefault, currentDefault) : skill
    })
    return structuredClone(skills)
  }

  getSkill(id: string): Skill | undefined {
    return this.listSkills().find((skill) => skill.id === id)
  }

  async upsertSkill(input: SkillInput): Promise<Skill> {
    return this.store.mutate((draft) => {
      const skills = draft.skills ?? localizedDefaultSkills()
      const existing = input.id ? skills.find((skill) => skill.id === input.id) : undefined
      const timestamp = new Date().toISOString()
      const entryFile = input.entryFile?.trim() || existing?.entryFile || 'SKILL.md'

      let files = input.files
      if (!files || files.length === 0) {
        if (input.systemPrompt?.trim()) {
          files = [
            {
              path: entryFile,
              content: input.systemPrompt.trim(),
              kind: 'markdown',
            },
          ]
        } else if (existing?.files?.length) {
          files = existing.files
        } else {
          files = [
            {
              path: entryFile,
              content: `# ${input.name.trim()}\n\n${input.description.trim()}`,
              kind: 'markdown',
            },
          ]
        }
      }

      const systemPrompt =
        input.systemPrompt?.trim() || files.find((f) => f.path === entryFile)?.content || files[0]?.content || ''

      const candidate: Skill = {
        id: input.id?.trim() || `skill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        name: input.name.trim(),
        description: input.description.trim(),
        icon: input.icon?.trim() || existing?.icon || undefined,
        entryFile,
        files,
        systemPrompt,
        isBuiltIn: existing?.isBuiltIn ?? false,
        enabled: input.enabled ?? existing?.enabled ?? true,
        author: input.author?.trim() || existing?.author || undefined,
        version: input.version?.trim() || existing?.version || '1.0.0',
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      }
      const validated = validateSkill(candidate, { strictEntry: true, strictPaths: true })
      if (existing) {
        draft.skills = skills.map((item) => (item.id === validated.id ? validated : item))
      } else {
        if (skills.length >= MAX_SKILLS) throw new Error(t('The Skill limit has been reached.'))
        draft.skills = [...skills, validated]
      }
      return structuredClone(validated)
    })
  }

  async removeSkill(id: string): Promise<void> {
    return this.store.mutate((draft) => {
      const skills = draft.skills ?? localizedDefaultSkills()
      const target = skills.find((skill) => skill.id === id)
      if (!target) return
      if (target.isBuiltIn) {
        throw new Error(t('System preset skills cannot be deleted and you can choose to deactivate them.'))
      }
      draft.skills = skills.filter((skill) => skill.id !== id)
    })
  }

  async toggleSkill(id: string, enabled: boolean): Promise<Skill> {
    return this.store.mutate((draft) => {
      const skills = draft.skills ?? localizedDefaultSkills()
      const target = skills.find((skill) => skill.id === id)
      if (!target) throw new Error(t('Skill not found.'))
      const updated: Skill = {
        ...target,
        enabled,
        updatedAt: new Date().toISOString(),
      }
      draft.skills = skills.map((item) => (item.id === id ? updated : item))
      return structuredClone(updated)
    })
  }

  async resetDefaultSkills(): Promise<Skill[]> {
    return this.store.mutate((draft) => {
      const current = draft.skills ?? []
      const customSkills = current.filter((skill) => !skill.isBuiltIn)
      const nextSkills = [...localizedDefaultSkills(), ...customSkills]
      draft.skills = nextSkills
      return structuredClone(nextSkills)
    })
  }

  listDataPlatOperations(conversationId: string): DataPlatOperation[] {
    return structuredClone(
      (this.store.readField('dataPlatOperations') ?? []).filter((op) => op.conversationId === conversationId),
    )
  }

  async recordDataPlatOperation(operation: DataPlatOperation): Promise<void> {
    const [validated] = parseDataPlatOperations([operation])
    if (!validated) throw new Error('Invalid data-plat operation')
    await this.store.mutate((draft) => {
      const current = (draft.dataPlatOperations ?? []).filter((op) => Date.parse(op.createdAt) > Date.now() - 86400000)
      if (current.some((op) => op.key === validated.key)) throw new Error('Data-plat operation already recorded')
      if (current.length >= 1000) throw new Error('Data-plat operation journal is full')
      draft.dataPlatOperations = [...current, validated]
    })
  }

  listMcpServers(): McpServerConfig[] {
    return this.store.readField('mcpServers') ?? []
  }

  listMcpServerViews(): McpServerConfig[] {
    return this.listMcpServers().map(maskMcpServerSecrets)
  }

  toMcpServerView(server: McpServerConfig): McpServerConfig {
    return maskMcpServerSecrets(server)
  }

  getMcpServer(id: string): McpServerConfig | undefined {
    return this.listMcpServers().find((server) => server.id === id)
  }

  async upsertMcpServer(input: McpServerInput): Promise<McpServerConfig> {
    return this.store.mutate((draft) => {
      const servers = draft.mcpServers ?? []
      const existing = input.id ? servers.find((s) => s.id === input.id) : undefined
      const resolvedInput = resolveMcpInputSecrets(input, existing)
      const timestamp = new Date().toISOString()
      const candidate: McpServerConfig = {
        id: resolvedInput.id?.trim() || `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        name: resolvedInput.name.trim(),
        description: resolvedInput.description?.trim() || undefined,
        enabled: resolvedInput.enabled ?? existing?.enabled ?? true,
        transport: resolvedInput.transport,
        command: resolvedInput.command?.trim() || undefined,
        args: resolvedInput.args,
        env: resolvedInput.env,
        url: resolvedInput.url?.trim() || undefined,
        headers: resolvedInput.headers,
        dataPlat: resolvedInput.dataPlat ?? undefined,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      }
      const validated = validateMcpServer(candidate)
      if (existing) {
        draft.mcpServers = servers.map((s) => (s.id === validated.id ? validated : s))
      } else {
        if (servers.length >= MAX_MCP_SERVERS) throw new Error(t('The MCP server limit has been reached.'))
        draft.mcpServers = [...servers, validated]
      }
      return structuredClone(validated)
    })
  }

  buildMcpServerCandidate(input: McpServerInput): McpServerInput {
    const existing = input.id ? this.getMcpServer(input.id) : undefined
    return resolveMcpInputSecrets(input, existing)
  }

  async removeMcpServer(id: string): Promise<void> {
    return this.store.mutate((draft) => {
      const servers = draft.mcpServers ?? []
      draft.mcpServers = servers.filter((s) => s.id !== id)
    })
  }

  async toggleMcpServer(id: string, enabled: boolean): Promise<McpServerConfig> {
    return this.store.mutate((draft) => {
      const servers = draft.mcpServers ?? []
      const target = servers.find((s) => s.id === id)
      if (!target) throw new Error(t('MCP server not found.'))
      const updated: McpServerConfig = {
        ...target,
        enabled,
        updatedAt: new Date().toISOString(),
      }
      draft.mcpServers = servers.map((s) => (s.id === id ? updated : s))
      return structuredClone(updated)
    })
  }

  listConversations(): Conversation[] {
    return this.store.readField('conversations').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  getConversation(id: string): Conversation | undefined {
    return this.store.readField('conversations').find((conversation) => conversation.id === id)
  }

  async saveConversation(conversation: Conversation): Promise<Conversation> {
    const validated = validateConversation(structuredClone(conversation))
    const existingConversation = this.getConversation(validated.id)
    const previousById = new Map(existingConversation?.messages.map((message) => [message.id, message]))
    for (const message of validated.messages) {
      if (previousById.get(message.id)?.governedData) message.governedData = true
    }
    if (existingConversation) {
      const nextMessageIds = new Set(validated.messages.map((message) => message.id))
      const removedAssistantIds = existingConversation.messages
        .filter((message) => message.role === 'assistant' && !nextMessageIds.has(message.id))
        .map((message) => message.id)
      for (const messageId of removedAssistantIds) {
        await this.getAgentCheckpointSaver()
          .deleteThread(agentCheckpointThreadId(validated.id, messageId))
          .catch((error) => {
            throw checkpointStorageError(error)
          })
      }
    }
    for (const message of validated.messages) {
      if (message.role !== 'assistant' || !message.interruption || !message.agentTrace?.length) continue
      const previous = previousById.get(message.id)
      if (previous?.interruption && previous.agentTrace?.length === message.agentTrace.length) continue
      const threadId = agentCheckpointThreadId(validated.id, message.id)
      const descriptor = await this.getAgentCheckpointSaver()
        .getThreadDescriptor(threadId)
        .catch((error) => {
          throw checkpointStorageError(error)
        })
      if (!descriptor) continue
      await this.getAgentCheckpointSaver()
        .setThreadDescriptor(threadId, {
          lifecycle: 'interrupted',
          hasTraceFallback: true,
        })
        .catch((error) => {
          throw checkpointStorageError(error)
        })
    }
    return this.store.mutate((draft) => {
      const existing = draft.conversations.some((item) => item.id === validated.id)
      if (existing) {
        const conversations = draft.conversations.map((item) => (item.id === validated.id ? validated : item))
        assertConversationMutationAllowed(draft.conversations, conversations)
        draft.conversations = conversations
      } else {
        const conversations = [...draft.conversations, validated]
        assertConversationMutationAllowed(draft.conversations, conversations)
        draft.conversations = conversations
      }
      return structuredClone(validated)
    })
  }

  async removeConversation(id: string): Promise<void> {
    await this.getAgentCheckpointSaver()
      .deleteThreadsForConversation(id)
      .catch((error) => {
        throw checkpointStorageError(error)
      })
    return this.store.mutate((draft) => {
      draft.conversations = draft.conversations.filter((conversation) => conversation.id !== id)
      draft.dataPlatOperations = (draft.dataPlatOperations ?? []).filter((operation) => operation.conversationId !== id)
      draft.browserProfiles = (draft.browserProfiles ?? []).filter((profile) => profile.conversationId !== id)
    })
  }

  /**
   * Clears all conversations (chat history) while keeping providers, models and
   * settings intact. The vault is re-encrypted and rewritten in full so the
   * active file no longer contains any chat content; the master key is
   * preserved so the retained provider/model configuration stays readable.
   */
  async clearConversations(): Promise<void> {
    await this.getAgentCheckpointSaver()
      .clear()
      .catch((error) => {
        throw checkpointStorageError(error)
      })
    return this.store.mutate((draft) => {
      draft.conversations = []
      draft.dataPlatOperations = []
      draft.browserProfiles = []
    })
  }

  getBrowserCookieProfile(conversationId: string): BrowserCookieProfile | undefined {
    const profile = (this.store.readField('browserProfiles') ?? []).find(
      (item) => item.conversationId === conversationId,
    )
    return profile ? structuredClone(profile) : undefined
  }

  async saveBrowserCookieProfile(
    conversationId: string,
    cookies: BrowserCookieRecord[],
  ): Promise<BrowserCookieProfile> {
    const profile = validateBrowserProfile({
      conversationId,
      cookies,
      updatedAt: new Date().toISOString(),
    })
    return this.store.mutate((draft) => {
      if (!draft.conversations.some((conversation) => conversation.id === conversationId)) {
        throw new Error(t('The browser cookie profile no longer belongs to a conversation.'))
      }
      const profiles = draft.browserProfiles ?? []
      const next = profiles.some((item) => item.conversationId === conversationId)
        ? profiles.map((item) => (item.conversationId === conversationId ? profile : item))
        : [...profiles, profile]
      if (next.length > MAX_BROWSER_COOKIE_PROFILES) throw new Error(t('Too many browser cookie profiles.'))
      const characters = JSON.stringify(next).length
      if (characters > MAX_BROWSER_COOKIE_CHARACTERS) throw new Error(t('Browser cookie storage is full.'))
      draft.browserProfiles = next
      return structuredClone(profile)
    })
  }

  async removeBrowserCookieProfile(conversationId: string): Promise<void> {
    return this.store.mutate((draft) => {
      draft.browserProfiles = (draft.browserProfiles ?? []).filter(
        (profile) => profile.conversationId !== conversationId,
      )
    })
  }

  async clearBrowserCookieProfiles(): Promise<void> {
    return this.store.mutate((draft) => {
      draft.browserProfiles = []
    })
  }
}

function checkpointStorageError(error: unknown): Error {
  const code = error instanceof CheckpointRepositoryError ? error.code : 'io'
  return new Error(t('Unable to update encrypted Agent recovery state ({value0}).', { value0: code }), {
    cause: error,
  })
}
