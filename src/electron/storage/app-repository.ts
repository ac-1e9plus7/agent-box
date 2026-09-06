import { randomUUID } from 'node:crypto'
import { parseDataPlatOperations, type DataPlatOperation } from '../mcp/data-plat-state'
import { isAbsolute, normalize } from 'node:path'
import type {
  AgentInterruption,
  ApiFormat,
  AppSettings,
  BrowserCookieProfile,
  BrowserCookieRecord,
  Conversation,
  McpServerConfig,
  McpServerInput,
  MessageAttachment,
  ModelConfig,
  ModelInput,
  ProviderInput,
  ProviderContinuation,
  ProviderRouting,
  ProviderView,
  Skill,
  SkillActivation,
  SkillFile,
  SkillFileKind,
  SkillInput,
  ToolCallExecution,
} from '../../shared/types'
import { isValidProviderContinuation } from '../../shared/provider-context'
import { EncryptedStore } from './encrypted-store'
import { CheckpointRepositoryError, EncryptedCheckpointRepository } from './checkpoint-repository'
import { AgentBoxCheckpointSaver } from './agentbox-checkpoint-saver'
import { agentCheckpointThreadId } from './checkpoint-identity'
import { DEFAULT_AGENT_TOOL_TURN_LIMIT, MAX_AGENT_SKILL_ACTIVATIONS } from '../../shared/agent-limits'
import {
  DEFAULT_AGENT_CONTEXT_COMPACTION_ENABLED,
  DEFAULT_AGENT_CONTEXT_COMPACTION_KEEP_RECENT_TURNS,
  DEFAULT_AGENT_CONTEXT_COMPACTION_THRESHOLD_PERCENT,
  DEFAULT_AGENT_DYNAMIC_TOOL_EXPOSURE_ENABLED,
  DEFAULT_AGENT_DYNAMIC_TOOL_LIMIT,
  DEFAULT_AGENT_LAZY_SKILL_RESOURCES_ENABLED,
  DEFAULT_AGENT_PROVIDER_CONTEXT_OPTIMIZATION_MODE,
  DEFAULT_AGENT_TOOL_RESULT_COMPACTION_ENABLED,
  DEFAULT_AGENT_TOOL_RESULT_MAX_CHARACTERS,
} from '../../shared/agent-token-optimization'
import { DEFAULT_BROWSER_HOME_PAGE } from '../../shared/browser-settings'
import { createOpenRouterAutoModel } from './default-models'
import { DEFAULT_SKILLS, localizedDefaultSkills } from './default-skills'
import { defaultDeveloperRuntimeSettings, normalizeAppSettings } from './settings-schema'
import { isApiKeyOptional, isLoopbackUrl } from '../api/provider-policy'
import { assertConversationMutationAllowed } from './vault-resource-limits'
import {
  citationCharacterCount,
  parseOptionalWebSearchMode,
  parseStoredCitations,
  parseStoredTokenUsage,
} from './web-metadata-schema'
import { APP_LANGUAGES, resourceBundle, t, type AppLanguage } from '../../shared/i18n'

export interface StoredProvider extends Omit<ProviderView, 'hasApiKey' | 'apiKeyOptional'> {
  apiKey?: string
}

export interface VaultState {
  schemaVersion: 1
  settings: AppSettings
  providers: StoredProvider[]
  models: ModelConfig[]
  conversations: Conversation[]
  skills?: Skill[]
  mcpServers?: McpServerConfig[]
  dataPlatOperations?: DataPlatOperation[]
  browserProfiles?: BrowserCookieProfile[]
}

const API_FORMATS = new Set<ApiFormat>(['openai-chat-completions', 'openai-responses', 'anthropic-messages'])
const MAX_PROVIDERS = 100
const MAX_MODELS = 2_000
const MAX_CONVERSATIONS = 10_000
const MAX_SKILLS = 500
const MAX_MCP_SERVERS = 100
const MAX_BROWSER_COOKIES_PER_PROFILE = 2_000
const MAX_BROWSER_COOKIE_PROFILES = 10_000
const MAX_BROWSER_COOKIE_CHARACTERS = 10_000_000
const MAX_MCP_ARGS = 50
const MAX_MCP_ENV_ENTRIES = 100
const MCP_SECRET_MASK = '••••••••'
const MAX_MESSAGES_PER_CONVERSATION = 20_000
const MAX_MESSAGE_CHARACTERS = 2_000_000
const MAX_CONVERSATION_CHARACTERS = 50_000_000

const DEFAULT_SETTINGS: AppSettings = {
  language: 'en-US',
  theme: 'system',
  sendShortcut: 'enter',
  contextManagementMode: 'manual',
  userNickname: '',
  userAvatar: '',
  defaultModelId: 'openrouter-auto',
  defaultReasoningEnabled: false,
  defaultReasoningEffort: 'medium',
  defaultAgentMode: false,
  agentToolTurnLimit: DEFAULT_AGENT_TOOL_TURN_LIMIT,
  agentToolResultCompactionEnabled: DEFAULT_AGENT_TOOL_RESULT_COMPACTION_ENABLED,
  agentToolResultMaxCharacters: DEFAULT_AGENT_TOOL_RESULT_MAX_CHARACTERS,
  agentDynamicToolExposureEnabled: DEFAULT_AGENT_DYNAMIC_TOOL_EXPOSURE_ENABLED,
  agentDynamicToolLimit: DEFAULT_AGENT_DYNAMIC_TOOL_LIMIT,
  agentLazySkillResourcesEnabled: DEFAULT_AGENT_LAZY_SKILL_RESOURCES_ENABLED,
  agentContextCompactionEnabled: DEFAULT_AGENT_CONTEXT_COMPACTION_ENABLED,
  agentContextCompactionThresholdPercent: DEFAULT_AGENT_CONTEXT_COMPACTION_THRESHOLD_PERCENT,
  agentContextCompactionKeepRecentTurns: DEFAULT_AGENT_CONTEXT_COMPACTION_KEEP_RECENT_TURNS,
  agentProviderContextOptimizationMode: DEFAULT_AGENT_PROVIDER_CONTEXT_OPTIMIZATION_MODE,
  builtInBrowserEnabled: false,
  browserHomePage: DEFAULT_BROWSER_HOME_PAGE,
  browserAllowHttpLoopback: false,
  browserPersistCookiesEnabled: false,
  browserAgentScreenshotsEnabled: false,
  browserFileUploadsEnabled: false,
  browserDownloadsEnabled: false,
  mcpEnabled: true,
  mcpToolRetrievalMode: 'auto',
  mcpToolApprovalPolicy: 'sensitive',
  toolApprovalTimeoutMode: 'five-minutes',
  systemPrompt: '',
  proxy: { mode: 'off', url: '' },
  integratedTerminalShell: { mode: 'auto', executable: '', args: [] },
  developerRuntimes: defaultDeveloperRuntimeSettings(),
  defaultWorkingDirectory: '',
}

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

  async initialize(): Promise<void> {
    await this.store.initialize()
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

  getAgentCheckpointSaver(): AgentBoxCheckpointSaver {
    if (!this.checkpointSaver) throw new Error('Agent checkpoint repository has not been initialized')
    return this.checkpointSaver
  }

  getSettings(): AppSettings {
    return this.store.read().settings
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
    return this.store.read().providers.map(toProviderView)
  }

  getStoredProvider(id: string): StoredProvider | undefined {
    return this.store.read().providers.find((provider) => provider.id === id)
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
    return this.store.read().models
  }

  getModel(id: string): ModelConfig | undefined {
    return this.store.read().models.find((model) => model.id === id)
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
    const storedSkills = this.store.read().skills ?? defaults
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
      (this.store.read().dataPlatOperations ?? []).filter((op) => op.conversationId === conversationId),
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
    return (this.store.read().mcpServers ?? []).map((s) => structuredClone(s))
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
    return this.store.read().conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  getConversation(id: string): Conversation | undefined {
    return this.store.read().conversations.find((conversation) => conversation.id === id)
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
    const profile = (this.store.read().browserProfiles ?? []).find((item) => item.conversationId === conversationId)
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

function buildStoredProvider(input: ProviderInput, existing?: StoredProvider): StoredProvider {
  if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 16_384)) {
    throw new Error(t('The API key is invalid or exceeds the length limit.'))
  }
  const timestamp = new Date().toISOString()
  const normalizedBaseUrl = normalizeBaseUrl(input.baseUrl)
  const suppliedApiKey = input.apiKey?.trim()
  const canRetainExistingKey = existing?.baseUrl === normalizedBaseUrl && existing.kind === input.kind
  const provider: StoredProvider = {
    id: existing?.id ?? randomUUID(),
    name: input.name.trim(),
    kind: input.kind,
    baseUrl: normalizedBaseUrl,
    apiFormat: input.apiFormat,
    apiKey: input.clearApiKey ? undefined : suppliedApiKey || (canRetainExistingKey ? existing.apiKey : undefined),
    defaultHeaders: sanitizeHeaders(input.defaultHeaders ?? existing?.defaultHeaders ?? {}),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  }
  validateStoredProvider(provider)
  return provider
}

function createDefaultVault(language: AppLanguage): VaultState {
  const timestamp = new Date().toISOString()
  return {
    schemaVersion: 1,
    settings: { ...structuredClone(DEFAULT_SETTINGS), language },
    providers: [
      {
        id: 'openrouter',
        name: 'OpenRouter',
        kind: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiFormat: 'openai-chat-completions',
        defaultHeaders: {
          'X-Title': 'AgentBox',
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    models: [createOpenRouterAutoModel(timestamp)],
    conversations: [],
    skills: localizedDefaultSkills(),
    mcpServers: [],
    browserProfiles: [],
  }
}

function validateVault(value: unknown, fallbackLanguage: AppLanguage): VaultState {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('Unsupported vault schema')
  }
  const providers = requireArray(value.providers, 'providers', MAX_PROVIDERS).map(parseStoredProvider)
  const models = requireArray(value.models, 'models', MAX_MODELS).map(parseModel)
  const conversations = requireArray(value.conversations, 'conversations', MAX_CONVERSATIONS).map(validateConversation)
  const skills =
    value.skills !== undefined
      ? requireArray(value.skills, 'skills', MAX_SKILLS).map((skill) => validateSkill(skill))
      : localizedDefaultSkills()
  const mcpServers = value.mcpServers !== undefined ? parseStoredMcpServers(value.mcpServers) : []
  const browserProfiles = (
    value.browserProfiles !== undefined ? parseStoredBrowserProfiles(value.browserProfiles) : []
  ).filter((profile) => conversations.some((conversation) => conversation.id === profile.conversationId))
  return {
    schemaVersion: 1,
    settings: normalizeAppSettings(value.settings, fallbackLanguage),
    providers,
    models,
    conversations,
    skills,
    mcpServers,
    dataPlatOperations: parseDataPlatOperations(value.dataPlatOperations),
    browserProfiles,
  }
}

function validateStoredProvider(value: unknown): asserts value is StoredProvider {
  if (!isRecord(value)) throw new Error('Invalid provider')
  requireNonEmptyString(value.id, 'provider id')
  requireNonEmptyString(value.name, 'provider name', 100)
  if (!['openrouter', 'openai', 'anthropic', 'cliproxy', 'custom'].includes(String(value.kind))) {
    throw new Error('Invalid provider kind')
  }
  normalizeBaseUrl(String(value.baseUrl))
  if (!API_FORMATS.has(value.apiFormat as ApiFormat)) throw new Error('Invalid API format')
  if (
    value.apiKey !== undefined &&
    (typeof value.apiKey !== 'string' || !value.apiKey.trim() || value.apiKey.length > 16_384)
  ) {
    throw new Error('Invalid API key')
  }
  sanitizeHeaders(value.defaultHeaders as Record<string, string>)
  requireIsoDate(value.createdAt, 'provider createdAt')
  requireIsoDate(value.updatedAt, 'provider updatedAt')
}

function parseStoredProvider(value: unknown): StoredProvider {
  validateStoredProvider(value)
  return {
    id: value.id,
    name: value.name,
    kind: value.kind,
    baseUrl: normalizeBaseUrl(value.baseUrl),
    apiFormat: value.apiFormat,
    apiKey: value.apiKey,
    defaultHeaders: sanitizeHeaders(value.defaultHeaders),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

function validateModel(value: unknown): asserts value is ModelConfig {
  if (!isRecord(value)) throw new Error('Invalid model')
  requireNonEmptyString(value.id, 'model id')
  requireNonEmptyString(value.name, 'model name', 200)
  requireNonEmptyString(value.providerId, 'provider id')
  requireNonEmptyString(value.remoteId, 'remote model id', 300)
  if (value.apiFormat !== undefined && !API_FORMATS.has(value.apiFormat as ApiFormat)) {
    throw new Error('Invalid model API format')
  }
  requirePositiveInteger(value.contextWindow, 'context window', 100_000_000)
  requirePositiveInteger(value.maxOutputTokens, 'max output tokens', 10_000_000)
  if (typeof value.supportsReasoning !== 'boolean' || typeof value.defaultReasoningEnabled !== 'boolean') {
    throw new Error('Invalid model reasoning flags')
  }
  if (!['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(value.defaultReasoningEffort))) {
    throw new Error('Invalid model reasoning effort')
  }
  parseOptionalWebSearchMode(value.defaultWebSearchMode, 'model web search mode')
  if (
    value.anthropicThinkingMode !== undefined &&
    !['adaptive', 'manual'].includes(String(value.anthropicThinkingMode))
  ) {
    throw new Error('Invalid Anthropic thinking mode')
  }
  sanitizeProviderRouting(value.providerRouting)
  requireIsoDate(value.createdAt, 'model createdAt')
  requireIsoDate(value.updatedAt, 'model updatedAt')
}

function parseModel(value: unknown): ModelConfig {
  validateModel(value)
  return {
    id: value.id,
    name: value.name,
    providerId: value.providerId,
    remoteId: value.remoteId,
    apiFormat: value.apiFormat,
    contextWindow: value.contextWindow,
    maxOutputTokens: value.maxOutputTokens,
    supportsReasoning: value.supportsReasoning,
    defaultReasoningEnabled: value.defaultReasoningEnabled,
    defaultReasoningEffort: value.defaultReasoningEffort,
    defaultWebSearchMode: parseOptionalWebSearchMode(value.defaultWebSearchMode, 'model web search mode'),
    anthropicThinkingMode: value.anthropicThinkingMode,
    providerRouting: sanitizeProviderRouting(value.providerRouting),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

const MAX_SKILL_FILES = 50
const MAX_SKILL_FILE_CHARACTERS = 500_000

function normalizeSkillFilePath(value: unknown, label: string): string {
  requireNonEmptyString(value, label, 255)
  const normalized = String(value).trim().replaceAll('\\', '/')
  if (
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('Invalid skill file path: directory traversal not allowed')
  }
  return normalized
}

function validateSkillFile(value: unknown, strictPaths: boolean): SkillFile {
  if (!isRecord(value)) throw new Error('Invalid skill file')
  requireNonEmptyString(value.path, 'skill file path', 255)
  let path: string
  try {
    path = normalizeSkillFilePath(value.path, 'skill file path')
  } catch (error) {
    if (strictPaths) throw error
    path = String(value.path).trim()
  }
  if (typeof value.content !== 'string' || value.content.length > MAX_SKILL_FILE_CHARACTERS) {
    throw new Error(`Invalid skill file content: ${path}`)
  }
  const knownKind = ['markdown', 'python', 'shell', 'other'].includes(String(value.kind))
  if (!knownKind && strictPaths) throw new Error(`Invalid skill file kind: ${path}`)
  return {
    path,
    content: value.content,
    kind: knownKind ? (value.kind as SkillFileKind) : 'other',
  }
}

function validateSkill(value: unknown, options: { strictEntry?: boolean; strictPaths?: boolean } = {}): Skill {
  if (!isRecord(value)) throw new Error('Invalid skill')
  requireNonEmptyString(value.id, 'skill id', 100)
  requireNonEmptyString(value.name, 'skill name', 200)
  if (typeof value.description !== 'string' || value.description.length > 2_000) {
    throw new Error('Invalid skill description')
  }
  if (value.icon !== undefined && (typeof value.icon !== 'string' || value.icon.length > 50)) {
    throw new Error('Invalid skill icon')
  }
  const rawEntryFile = typeof value.entryFile === 'string' && value.entryFile.trim() ? value.entryFile : 'SKILL.md'
  let entryFile: string
  try {
    entryFile = normalizeSkillFilePath(rawEntryFile, 'skill entry file')
  } catch (error) {
    if (options.strictPaths) throw error
    entryFile = String(rawEntryFile).trim()
  }

  let files: SkillFile[] = []
  if (Array.isArray(value.files) && value.files.length > 0) {
    if (value.files.length > MAX_SKILL_FILES) throw new Error(t('Skill contains more files than the limit'))
    files = value.files.map((file) => validateSkillFile(file, options.strictPaths === true))
    if (options.strictPaths && new Set(files.map((file) => file.path)).size !== files.length) {
      throw new Error('Skill file paths must be unique')
    }
  } else if (typeof value.systemPrompt === 'string' && value.systemPrompt.trim()) {
    if (value.systemPrompt.length > MAX_SKILL_FILE_CHARACTERS) {
      throw new Error('Invalid skill system prompt')
    }
    files = [
      {
        path: entryFile,
        content: value.systemPrompt.trim(),
        kind: 'markdown',
      },
    ]
  }

  const entryDocument = files.find((file) => file.path === entryFile && file.kind === 'markdown')
  if (options.strictEntry && !entryDocument) {
    throw new Error(t('A Skill entry file must be an included Markdown document.'))
  }
  if (!entryDocument && !options.strictEntry) {
    const legacyEntryDocument = files.find((file) => file.kind === 'markdown')
    if (legacyEntryDocument) entryFile = legacyEntryDocument.path
  }

  const suppliedSystemPrompt = typeof value.systemPrompt === 'string' ? value.systemPrompt.trim() : ''
  if (suppliedSystemPrompt.length > MAX_SKILL_FILE_CHARACTERS) {
    throw new Error('Invalid skill system prompt')
  }
  const systemPrompt =
    suppliedSystemPrompt || files.find((file) => file.path === entryFile && file.kind === 'markdown')?.content || ''

  if (value.isBuiltIn !== undefined && typeof value.isBuiltIn !== 'boolean') {
    throw new Error('Invalid skill built-in flag')
  }
  if (typeof value.enabled !== 'boolean') {
    throw new Error('Invalid skill enabled flag')
  }
  if (value.author !== undefined && (typeof value.author !== 'string' || value.author.length > 200)) {
    throw new Error('Invalid skill author')
  }
  if (value.version !== undefined && (typeof value.version !== 'string' || value.version.length > 50)) {
    throw new Error('Invalid skill version')
  }
  if (value.createdAt !== undefined) requireIsoDate(value.createdAt, 'skill createdAt')
  if (value.updatedAt !== undefined) requireIsoDate(value.updatedAt, 'skill updatedAt')
  return {
    id: value.id,
    name: value.name,
    description: value.description,
    icon: value.icon,
    entryFile,
    files,
    systemPrompt,
    isBuiltIn: Boolean(value.isBuiltIn),
    enabled: value.enabled,
    author: value.author,
    version: value.version,
    createdAt: value.createdAt ?? new Date().toISOString(),
    updatedAt: value.updatedAt ?? new Date().toISOString(),
  }
}

function validateMcpServer(value: unknown): McpServerConfig {
  if (!isRecord(value)) throw new Error('Invalid MCP server config')
  requireNonEmptyString(value.id, 'mcp server id', 100)
  requireNonEmptyString(value.name, 'mcp server name', 200)
  if (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 2_000)) {
    throw new Error('Invalid MCP server description')
  }
  if (typeof value.enabled !== 'boolean') {
    throw new Error('Invalid MCP server enabled flag')
  }
  const transport = String(value.transport)
  if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') {
    throw new Error('Invalid MCP server transport: must be stdio, http, or sse')
  }

  let command: string | undefined
  let args: string[] | undefined
  let env: Record<string, string> | undefined
  let url: string | undefined
  let headers: Record<string, string> | undefined

  if (transport === 'stdio') {
    requireNonEmptyString(value.command, 'mcp server command', 500)
    command = value.command.trim()
    if (value.args !== undefined) {
      if (!Array.isArray(value.args) || value.args.length > MAX_MCP_ARGS) {
        throw new Error('Invalid MCP server args: too many arguments')
      }
      args = value.args.map((arg, idx) => {
        if (typeof arg !== 'string' || arg.length > 8_192) {
          throw new Error(`Invalid MCP server arg at index ${idx}`)
        }
        return arg
      })
    }
    if (value.env !== undefined) {
      if (!isRecord(value.env)) throw new Error('Invalid MCP server env')
      const envEntries = Object.entries(value.env)
      if (envEntries.length > MAX_MCP_ENV_ENTRIES) {
        throw new Error('Too many environment variables for MCP server')
      }
      env = {}
      for (const [k, v] of envEntries) {
        const key = k.trim()
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
          throw new Error(`Invalid environment variable key: ${key}`)
        }
        if (typeof v !== 'string' || v.length > 8_192) {
          throw new Error(`Invalid environment variable value for: ${key}`)
        }
        env[key] = v
      }
    }
  } else {
    requireNonEmptyString(value.url, 'mcp server url', 2_000)
    url = normalizeBaseUrl(value.url)
    if (value.headers !== undefined) {
      headers = sanitizeMcpHeaders(value.headers as Record<string, string>)
    }
  }

  let dataPlat: McpServerConfig['dataPlat']
  if (value.dataPlat !== undefined && value.dataPlat !== null) {
    if (transport !== 'http' || !isRecord(value.dataPlat)) throw new Error('Data-plat requires HTTP transport')
    requireNonEmptyString(value.dataPlat.apiBaseUrl, 'data-plat API base URL', 2000)
    requireNonEmptyString(value.dataPlat.agentId, 'data-plat Agent ID', 128)
    requireNonEmptyString(value.dataPlat.loginToken, 'data-plat login token', 16384)
    const api = new URL(value.dataPlat.apiBaseUrl)
    if (
      api.username ||
      api.password ||
      api.search ||
      api.hash ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.dataPlat.agentId) ||
      /[\r\n]/.test(value.dataPlat.loginToken)
    )
      throw new Error('Invalid data-plat configuration')
    dataPlat = {
      apiBaseUrl: normalizeBaseUrl(value.dataPlat.apiBaseUrl),
      agentId: value.dataPlat.agentId.toLowerCase(),
      loginToken: value.dataPlat.loginToken,
    }
  }

  requireIsoDate(value.createdAt, 'mcp server createdAt')
  requireIsoDate(value.updatedAt, 'mcp server updatedAt')

  return {
    id: value.id,
    name: value.name,
    description: value.description?.trim() || undefined,
    enabled: value.enabled,
    transport,
    command,
    args,
    env,
    url,
    headers,
    dataPlat,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

function parseStoredMcpServers(value: unknown): McpServerConfig[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('Invalid MCP servers in vault')
  if (value.length > MAX_MCP_SERVERS) throw new Error('Too many MCP servers in vault')
  return value.map(validateMcpServer)
}

function parseStoredBrowserProfiles(value: unknown): BrowserCookieProfile[] {
  if (!Array.isArray(value) || value.length > MAX_BROWSER_COOKIE_PROFILES) {
    throw new Error('Invalid browser cookie profiles in vault')
  }
  if (JSON.stringify(value).length > MAX_BROWSER_COOKIE_CHARACTERS) {
    throw new Error('Browser cookie profiles are too large')
  }
  return value.map(validateBrowserProfile)
}

function validateBrowserProfile(value: unknown): BrowserCookieProfile {
  if (!isRecord(value)) throw new Error('Invalid browser cookie profile')
  requireNonEmptyString(value.conversationId, 'browser cookie conversation id', 500)
  requireIsoDate(value.updatedAt, 'browser cookie profile updatedAt')
  const cookies = requireArray(value.cookies, 'browser cookies', MAX_BROWSER_COOKIES_PER_PROFILE).map(
    validateBrowserCookie,
  )
  return { conversationId: value.conversationId, cookies, updatedAt: value.updatedAt }
}

function validateBrowserCookie(value: unknown): BrowserCookieRecord {
  if (!isRecord(value)) throw new Error('Invalid browser cookie')
  requireNonEmptyString(value.name, 'browser cookie name', 256)
  if (/[\r\n\0]/.test(value.name)) throw new Error('Invalid browser cookie name')
  if (typeof value.value !== 'string' || value.value.length > 16_384 || /[\r\n\0]/.test(value.value)) {
    throw new Error('Invalid browser cookie value')
  }
  requireNonEmptyString(value.domain, 'browser cookie domain', 1_000)
  requireNonEmptyString(value.path, 'browser cookie path', 2_000)
  if (/[\r\n\0]/.test(value.domain) || /[\r\n\0]/.test(value.path)) {
    throw new Error('Invalid browser cookie scope')
  }
  if (typeof value.secure !== 'boolean' || typeof value.httpOnly !== 'boolean' || typeof value.session !== 'boolean') {
    throw new Error('Invalid browser cookie flags')
  }
  if (
    value.sameSite !== undefined &&
    !['unspecified', 'no_restriction', 'lax', 'strict'].includes(String(value.sameSite))
  ) {
    throw new Error('Invalid browser cookie SameSite value')
  }
  if (
    value.expirationDate !== undefined &&
    (typeof value.expirationDate !== 'number' || !Number.isFinite(value.expirationDate) || value.expirationDate < 0)
  ) {
    throw new Error('Invalid browser cookie expiration')
  }
  return {
    name: value.name,
    value: value.value,
    domain: value.domain,
    path: value.path,
    secure: value.secure,
    httpOnly: value.httpOnly,
    session: value.session,
    sameSite: value.sameSite as BrowserCookieRecord['sameSite'],
    expirationDate: value.expirationDate,
  }
}

function parseStoredToolExecutions(value: unknown): ToolCallExecution[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error('Invalid tool executions')
  if (value.length > 500) throw new Error('Too many tool executions')
  if (value.length === 0) return undefined
  return value.map((item) => {
    if (!isRecord(item)) throw new Error('Invalid tool execution item')
    requireNonEmptyString(item.id, 'tool execution id', 120)
    requireNonEmptyString(item.toolName, 'tool execution toolName', 200)
    const serverId = typeof item.serverId === 'string' && item.serverId.trim() ? item.serverId.trim() : undefined
    const serverName =
      typeof item.serverName === 'string' && item.serverName.trim() ? item.serverName.trim() : undefined
    if (!isRecord(item.args)) throw new Error('Invalid tool execution args')
    const result = typeof item.result === 'string' ? item.result.slice(0, 1_000_000) : undefined
    const isError = typeof item.isError === 'boolean' ? item.isError : undefined
    const status = ['calling', 'awaiting-approval', 'executing', 'complete', 'denied', 'error'].includes(
      String(item.status),
    )
      ? (item.status as ToolCallExecution['status'])
      : 'complete'
    return {
      id: item.id,
      toolName: item.toolName,
      modelToolName: typeof item.modelToolName === 'string' ? item.modelToolName.slice(0, 64) : undefined,
      serverId,
      serverName,
      turn: Number.isInteger(item.turn) && Number(item.turn) > 0 ? Number(item.turn) : undefined,
      args: parseStoredJsonRecord(item.args, 200_000),
      result,
      resultContent: parseStoredToolResultContent(item.resultContent),
      structuredResult: isRecord(item.structuredResult)
        ? parseStoredJsonRecord(item.structuredResult, 100_000)
        : undefined,
      resultTruncated: typeof item.resultTruncated === 'boolean' ? item.resultTruncated : undefined,
      isError,
      riskLevel: item.riskLevel === 'low' || item.riskLevel === 'sensitive' ? item.riskLevel : undefined,
      approvalReason: typeof item.approvalReason === 'string' ? item.approvalReason.slice(0, 2_000) : undefined,
      approvalKind: ['generic', 'browser-navigation', 'browser-share', 'browser-interaction'].includes(
        String(item.approvalKind),
      )
        ? (item.approvalKind as ToolCallExecution['approvalKind'])
        : undefined,
      approvalScope:
        isRecord(item.approvalScope) &&
        item.approvalScope.kind === 'browser-origin' &&
        typeof item.approvalScope.origin === 'string'
          ? {
              kind: 'browser-origin' as const,
              origin: item.approvalScope.origin.slice(0, 2_000),
              capabilities: ['read'] as ['read'],
            }
          : undefined,
      status,
    }
  })
}

function mergeLocalizedBuiltInSkill(stored: Skill, source: Skill, localized: Skill): Skill {
  const files = stored.files.map((storedFile) => {
    const sourceFile = source.files.find((file) => file.path === storedFile.path)
    const localizedFile = localized.files.find((file) => file.path === storedFile.path)
    if (sourceFile && localizedFile && isBundledMessageValue(storedFile.content, sourceFile.content)) {
      return { ...localizedFile }
    }
    return storedFile
  })
  const sourcePrompt =
    source.systemPrompt ||
    source.files.find((file) => file.path === source.entryFile)?.content ||
    source.files[0]?.content
  const localizedPrompt =
    localized.systemPrompt ||
    localized.files.find((file) => file.path === localized.entryFile)?.content ||
    localized.files[0]?.content
  const systemPrompt =
    sourcePrompt && localizedPrompt && stored.systemPrompt && isBundledMessageValue(stored.systemPrompt, sourcePrompt)
      ? localizedPrompt
      : stored.systemPrompt
  return {
    ...stored,
    name: localized.name,
    description: localized.description,
    files,
    systemPrompt,
  }
}

function isBundledMessageValue(value: string, messageKey: string): boolean {
  return value === messageKey || APP_LANGUAGES.some((language) => resourceBundle(language)[messageKey] === value)
}

function parseStoredSkillActivations(value: unknown): SkillActivation[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > MAX_AGENT_SKILL_ACTIVATIONS) throw new Error('Invalid skill activations')
  const parsed = value.map((item): SkillActivation => {
    if (!isRecord(item)) throw new Error('Invalid skill activation item')
    requireNonEmptyString(item.id, 'skill activation id', 100)
    requireNonEmptyString(item.name, 'skill activation name', 200)
    if (!['automatic', 'explicit', 'model'].includes(String(item.source))) {
      throw new Error('Invalid skill activation source')
    }
    return {
      id: item.id,
      name: item.name,
      source: item.source as SkillActivation['source'],
      turn: Number.isInteger(item.turn) && Number(item.turn) >= 0 ? Number(item.turn) : undefined,
    }
  })
  return parsed.length > 0 ? parsed : undefined
}

function parseStoredAgentTrace(value: unknown): import('../../shared/types').AgentTraceItem[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > 2_000) throw new Error('Invalid agent trace')
  if (value.length === 0) return undefined
  return value.map((item) => {
    if (!isRecord(item) || !Number.isInteger(item.turn) || Number(item.turn) < 1) {
      throw new Error('Invalid agent trace item')
    }
    const turn = Number(item.turn)
    if (item.type === 'assistant_text' && typeof item.text === 'string') {
      return { type: 'assistant_text', turn, text: item.text.slice(0, MAX_MESSAGE_CHARACTERS) }
    }
    if (item.type === 'assistant_thinking' && Number.isInteger(item.blockIndex) && typeof item.thinking === 'string') {
      return {
        type: 'assistant_thinking',
        turn,
        blockIndex: Number(item.blockIndex),
        thinking: item.thinking.slice(0, MAX_MESSAGE_CHARACTERS),
        signature: typeof item.signature === 'string' ? item.signature.slice(0, 100_000) : undefined,
      }
    }
    if (
      item.type === 'provider_item' &&
      item.format === 'openai-responses' &&
      isRecord(item.item) &&
      item.item.type === 'reasoning'
    ) {
      return {
        type: 'provider_item',
        turn,
        format: 'openai-responses',
        item: parseStoredJsonRecord(item.item, 500_000),
      }
    }
    if (
      item.type === 'tool_call' &&
      typeof item.callId === 'string' &&
      typeof item.toolName === 'string' &&
      typeof item.modelToolName === 'string' &&
      isRecord(item.args)
    ) {
      return {
        type: 'tool_call',
        turn,
        callId: item.callId.slice(0, 200),
        toolName: item.toolName.slice(0, 200),
        modelToolName: item.modelToolName.slice(0, 64),
        serverId: typeof item.serverId === 'string' ? item.serverId.slice(0, 100) : undefined,
        serverName: typeof item.serverName === 'string' ? item.serverName.slice(0, 200) : undefined,
        args: parseStoredJsonRecord(item.args, 200_000),
      }
    }
    if (
      item.type === 'tool_result' &&
      typeof item.callId === 'string' &&
      typeof item.toolName === 'string' &&
      typeof item.result === 'string'
    ) {
      return {
        type: 'tool_result',
        turn,
        callId: item.callId.slice(0, 200),
        toolName: item.toolName.slice(0, 200),
        result: item.result.slice(0, 100_000),
        resultContent: parseStoredToolResultContent(item.resultContent),
        structuredResult: isRecord(item.structuredResult)
          ? parseStoredJsonRecord(item.structuredResult, 100_000)
          : undefined,
        resultTruncated: typeof item.resultTruncated === 'boolean' ? item.resultTruncated : undefined,
        isError: typeof item.isError === 'boolean' ? item.isError : undefined,
      }
    }
    throw new Error('Invalid agent trace item')
  })
}

function parseStoredAgentInterruption(value: unknown): AgentInterruption | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new Error('Invalid Agent interruption')
  if (
    ![
      'rate_limit',
      'network',
      'timeout',
      'cancelled',
      'tool_turn_limit',
      'output_limit',
      'api_error',
      'checkpoint_error',
      'unknown',
    ].includes(String(value.reason))
  )
    throw new Error('Invalid Agent interruption reason')
  requireNonEmptyString(value.message, 'Agent interruption message', 10_000)
  requireIsoDate(value.occurredAt, 'Agent interruption occurredAt')
  if (
    value.status !== undefined &&
    (!Number.isInteger(value.status) || Number(value.status) < 100 || Number(value.status) > 599)
  ) {
    throw new Error('Invalid Agent interruption status')
  }
  if (
    value.retryAfterSeconds !== undefined &&
    (!Number.isFinite(value.retryAfterSeconds) ||
      Number(value.retryAfterSeconds) < 0 ||
      Number(value.retryAfterSeconds) > 86_400)
  ) {
    throw new Error('Invalid Agent interruption retry delay')
  }
  return {
    reason: value.reason as AgentInterruption['reason'],
    message: value.message,
    occurredAt: value.occurredAt,
    errorCode: typeof value.errorCode === 'string' ? value.errorCode.slice(0, 200) : undefined,
    status: value.status === undefined ? undefined : Number(value.status),
    retryAfterSeconds: value.retryAfterSeconds === undefined ? undefined : Number(value.retryAfterSeconds),
    finishReason: typeof value.finishReason === 'string' ? value.finishReason.slice(0, 200) : undefined,
  }
}

function parseStoredProviderContinuation(value: unknown): ProviderContinuation | undefined {
  if (value === undefined) return undefined
  if (!isValidProviderContinuation(value)) throw new Error('Invalid provider continuation')
  return {
    format: value.format,
    responseId: value.responseId,
    turn: value.turn,
  }
}

function parseStoredToolResultContent(value: unknown): import('../../shared/types').McpToolResultContent[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid tool result content')
  const parsed = value.flatMap((item): import('../../shared/types').McpToolResultContent[] => {
    if (!isRecord(item)) return []
    if (item.type === 'text' && typeof item.text === 'string')
      return [{ type: 'text', text: item.text.slice(0, 100_000) }]
    if ((item.type === 'image' || item.type === 'audio') && typeof item.mimeType === 'string') {
      return [
        {
          type: item.type,
          mimeType: item.mimeType.slice(0, 100),
          data: typeof item.data === 'string' && item.data.length <= 2 * 1024 * 1024 ? item.data : undefined,
        },
      ]
    }
    if (item.type === 'resource' && typeof item.uri === 'string') {
      return [
        {
          type: 'resource',
          uri: item.uri.slice(0, 2_000),
          mimeType: typeof item.mimeType === 'string' ? item.mimeType.slice(0, 100) : undefined,
          text: typeof item.text === 'string' ? item.text.slice(0, 100_000) : undefined,
        },
      ]
    }
    if (item.type === 'resource_link' && typeof item.uri === 'string' && typeof item.name === 'string') {
      return [
        {
          type: 'resource_link',
          uri: item.uri.slice(0, 2_000),
          name: item.name.slice(0, 300),
          description: typeof item.description === 'string' ? item.description.slice(0, 4_000) : undefined,
          mimeType: typeof item.mimeType === 'string' ? item.mimeType.slice(0, 100) : undefined,
        },
      ]
    }
    return []
  })
  return parsed.length ? parsed : undefined
}

function parseStoredJsonRecord(value: Record<string, unknown>, maxCharacters: number): Record<string, unknown> {
  const serialized = JSON.stringify(value)
  if (serialized.length > maxCharacters) throw new Error('Stored JSON object is too large')
  return JSON.parse(serialized) as Record<string, unknown>
}

function validateConversation(value: unknown): Conversation {
  if (!isRecord(value)) throw new Error('Invalid conversation')
  requireNonEmptyString(value.id, 'conversation id')
  requireNonEmptyString(value.title, 'conversation title', 500)
  requireNonEmptyString(value.modelId, 'conversation model id')
  if (value.reasoningEnabled !== undefined && typeof value.reasoningEnabled !== 'boolean') {
    throw new Error('Invalid conversation reasoning flag')
  }
  if (value.agentMode !== undefined && typeof value.agentMode !== 'boolean') {
    throw new Error('Invalid conversation agent mode flag')
  }
  if (value.browserToolEnabled !== undefined && typeof value.browserToolEnabled !== 'boolean') {
    throw new Error('Invalid conversation browser tool flag')
  }
  const skillIds = Array.isArray(value.skillIds)
    ? [
        ...new Set(
          value.skillIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()) && id.length <= 100),
        ),
      ].slice(0, MAX_AGENT_SKILL_ACTIVATIONS)
    : undefined
  const mcpServerIds = Array.isArray(value.mcpServerIds)
    ? value.mcpServerIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()) && id.length <= 100)
    : undefined
  const webSearchMode = parseOptionalWebSearchMode(value.webSearchMode, 'conversation web search mode')
  const workingDirectory =
    typeof value.workingDirectory === 'string' && value.workingDirectory.trim()
      ? normalizeConversationWorkingDirectory(value.workingDirectory)
      : undefined
  const messages = requireArray(value.messages, 'messages', MAX_MESSAGES_PER_CONVERSATION).map((message) => {
    if (!isRecord(message)) throw new Error('Invalid message')
    requireNonEmptyString(message.id, 'message id')
    if (!['system', 'user', 'assistant'].includes(String(message.role))) {
      throw new Error('Invalid message role')
    }
    if (typeof message.content !== 'string' || message.content.length > MAX_MESSAGE_CHARACTERS) {
      throw new Error('Invalid message content')
    }
    if (
      message.reasoning !== undefined &&
      (typeof message.reasoning !== 'string' || message.reasoning.length > MAX_MESSAGE_CHARACTERS)
    ) {
      throw new Error('Invalid message reasoning')
    }
    requireIsoDate(message.createdAt, 'message createdAt')
    const citations = parseStoredCitations(message.citations)
    const usage = parseStoredTokenUsage(message.usage)
    const attachments = parseStoredAttachments(message.attachments)
    const skillActivations = parseStoredSkillActivations(message.skillActivations)
    const toolExecutions = parseStoredToolExecutions(message.toolExecutions)
    const agentTrace = parseStoredAgentTrace(message.agentTrace)
    const providerContinuation = parseStoredProviderContinuation(message.providerContinuation)
    const interruption = parseStoredAgentInterruption(message.interruption)
    if (providerContinuation && message.role !== 'assistant') {
      throw new Error('Only assistant messages can store provider continuations')
    }
    if (interruption && message.role !== 'assistant')
      throw new Error('Only assistant messages can store Agent interruptions')
    const parentMessageId =
      message.parentMessageId === null
        ? null
        : typeof message.parentMessageId === 'string' && message.parentMessageId.trim()
          ? message.parentMessageId.trim()
          : undefined
    return {
      id: message.id,
      role: message.role,
      governedData: message.governedData === true || undefined,
      content: message.content,
      parentMessageId,
      reasoning: message.reasoning,
      citations,
      usage,
      modelId: typeof message.modelId === 'string' && message.modelId.trim() ? message.modelId.trim() : undefined,
      attachments,
      skillActivations,
      toolExecutions,
      agentTrace,
      providerContinuation,
      interruption,
      createdAt: message.createdAt,
    } as Conversation['messages'][number]
  })
  const totalCharacters = messages.reduce(
    (sum, message) =>
      sum +
      message.content.length +
      (message.reasoning?.length ?? 0) +
      citationCharacterCount(message.citations) +
      attachmentCharacterCount(message.attachments) +
      JSON.stringify(message.usage ?? {}).length +
      JSON.stringify(message.skillActivations ?? []).length +
      JSON.stringify(message.agentTrace ?? []).length +
      (message.providerContinuation?.responseId.length ?? 0) +
      (message.interruption?.message.length ?? 0) +
      (message.agentTrace?.length ? 0 : JSON.stringify(message.toolExecutions ?? []).length),
    0,
  )
  if (totalCharacters > MAX_CONVERSATION_CHARACTERS) {
    throw new Error('Conversation is too large')
  }
  requireIsoDate(value.createdAt, 'conversation createdAt')
  requireIsoDate(value.updatedAt, 'conversation updatedAt')
  const currentLeafId =
    typeof value.currentLeafId === 'string' && value.currentLeafId.trim() ? value.currentLeafId.trim() : undefined
  return {
    id: value.id,
    title: value.title,
    modelId: value.modelId,
    reasoningEnabled: value.reasoningEnabled,
    agentMode: value.agentMode,
    browserToolEnabled: value.browserToolEnabled,
    skillIds,
    mcpServerIds,
    workingDirectory,
    webSearchMode,
    messages,
    currentLeafId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

function sanitizeProviderRouting(value: unknown): ProviderRouting | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error('Invalid provider routing')
  const order = sanitizeProviderSlugs(value.order, 'provider order')
  const only = sanitizeProviderSlugs(value.only, 'provider allow-list')
  if (value.allowFallbacks !== undefined && typeof value.allowFallbacks !== 'boolean') {
    throw new Error('Invalid provider fallback setting')
  }
  if (value.requireParameters !== undefined && typeof value.requireParameters !== 'boolean') {
    throw new Error('Invalid provider parameter setting')
  }
  if (value.zdr !== undefined && typeof value.zdr !== 'boolean') {
    throw new Error('Invalid provider ZDR setting')
  }
  if (value.dataCollection !== undefined && !['allow', 'deny'].includes(String(value.dataCollection))) {
    throw new Error('Invalid provider data-collection setting')
  }
  if (value.sort !== undefined && !['price', 'throughput', 'latency'].includes(String(value.sort))) {
    throw new Error('Invalid provider sort setting')
  }
  return {
    order,
    only,
    allowFallbacks: value.allowFallbacks,
    requireParameters: value.requireParameters,
    dataCollection: value.dataCollection as ProviderRouting['dataCollection'],
    zdr: value.zdr,
    sort: value.sort as ProviderRouting['sort'],
  }
}

function sanitizeProviderSlugs(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 100) throw new Error(`Invalid ${label}`)
  return value.map((item) => {
    if (typeof item !== 'string' || !item || item.length > 100 || !/^[0-9A-Za-z._/-]+$/.test(item)) {
      throw new Error(`Invalid ${label}`)
    }
    return item
  })
}

function toProviderView(provider: StoredProvider): ProviderView {
  const { apiKey: _apiKey, ...safeProvider } = provider
  return {
    ...safeProvider,
    hasApiKey: Boolean(provider.apiKey),
    apiKeyOptional: isApiKeyOptional(provider),
  }
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value.trim())
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new Error(t('The provider URL must use HTTP or HTTPS.'))
  }
  if (url.protocol === 'http:' && !isLoopbackUrl(url.toString())) {
    throw new Error(t('Remote provider URLs must use HTTPS; HTTP is allowed only for local loopback addresses.'))
  }
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function sanitizeHeaders(value: Record<string, string>): Record<string, string> {
  if (!isRecord(value)) throw new Error('Invalid custom headers')
  const forbidden = new Set([
    'authorization',
    'proxy-authorization',
    'x-api-key',
    'cookie',
    'set-cookie',
    'host',
    'content-length',
  ])
  const output: Record<string, string> = {}
  const entries = Object.entries(value)
  if (entries.length > 32) throw new Error('Too many custom headers')
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim()
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || forbidden.has(name.toLowerCase())) {
      throw new Error(t('Request header not allowed: {value0}', { value0: name }))
    }
    if (typeof rawValue !== 'string' || /[\r\n]/.test(rawValue) || rawValue.length > 4_096) {
      throw new Error(t('The value of the request header {value0} is invalid.', { value0: name }))
    }
    output[name] = rawValue
  }
  return output
}

function normalizeConversationWorkingDirectory(value: string): string {
  if (value.length > 4_096 || /[\r\n\0]/.test(value) || !isAbsolute(value)) {
    throw new Error('Invalid conversation working directory')
  }
  return normalize(value)
}

function sanitizeMcpHeaders(value: Record<string, string>): Record<string, string> {
  if (!isRecord(value)) throw new Error('Invalid MCP headers')
  const forbidden = new Set(['proxy-authorization', 'cookie', 'set-cookie', 'host', 'content-length'])
  const output: Record<string, string> = {}
  const entries = Object.entries(value)
  if (entries.length > 32) throw new Error('Too many MCP headers')
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim()
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || forbidden.has(name.toLowerCase())) {
      throw new Error(t('MCP request header not allowed: {value0}', { value0: name }))
    }
    if (typeof rawValue !== 'string' || /[\r\n]/.test(rawValue) || rawValue.length > 8_192) {
      throw new Error(t('The MCP request header {value0} has an invalid value.', { value0: name }))
    }
    output[name] = rawValue
  }
  return output
}

function resolveMcpInputSecrets(input: McpServerInput, existing?: McpServerConfig): McpServerInput {
  const mergeMasked = (
    incoming: Record<string, string> | undefined,
    stored: Record<string, string> | undefined,
    clear: boolean | undefined,
  ): Record<string, string> | undefined => {
    if (clear) return undefined
    if (incoming === undefined) return stored ? structuredClone(stored) : undefined
    return Object.fromEntries(
      Object.entries(incoming).map(([key, value]) => [
        key,
        value === MCP_SECRET_MASK && stored?.[key] !== undefined ? stored[key] : value,
      ]),
    )
  }
  return {
    ...input,
    dataPlat:
      input.dataPlat === null
        ? null
        : input.dataPlat === undefined
          ? existing?.dataPlat
          : {
              ...input.dataPlat,
              loginToken:
                input.dataPlat.loginToken === MCP_SECRET_MASK
                  ? (existing?.dataPlat?.loginToken ?? '')
                  : input.dataPlat.loginToken,
            },
    env: mergeMasked(input.env, existing?.env, input.clearEnv),
    headers: mergeMasked(input.headers, existing?.headers, input.clearHeaders),
  }
}

function maskMcpServerSecrets(server: McpServerConfig): McpServerConfig {
  const mask = (value?: Record<string, string>): Record<string, string> | undefined =>
    value ? Object.fromEntries(Object.keys(value).map((key) => [key, MCP_SECRET_MASK])) : undefined
  return {
    ...structuredClone(server),
    dataPlat: server.dataPlat ? { ...server.dataPlat, loginToken: MCP_SECRET_MASK } : undefined,
    env: mask(server.env),
    headers: mask(server.headers),
  }
}

function parseStoredAttachments(value: unknown): MessageAttachment[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error('Invalid message attachments')
  if (value.length > 20) throw new Error('Too many message attachments')
  if (value.length === 0) return undefined

  return value.map((item) => {
    if (!isRecord(item)) throw new Error('Invalid message attachment')
    requireNonEmptyString(item.id, 'attachment id', 120)
    requireNonEmptyString(item.name, 'attachment name', 300)
    requireNonEmptyString(item.mimeType, 'attachment mimeType', 100)
    if (typeof item.size !== 'number' || !Number.isFinite(item.size) || item.size < 0 || item.size > 50 * 1024 * 1024) {
      throw new Error('Invalid attachment size')
    }
    if (typeof item.type !== 'string' || !['image', 'document', 'text'].includes(item.type)) {
      throw new Error('Invalid attachment type')
    }
    if (typeof item.data !== 'string' || item.data.length > 40_000_000) {
      throw new Error('Invalid attachment data')
    }
    return {
      id: item.id,
      name: item.name,
      mimeType: item.mimeType,
      size: Math.trunc(item.size),
      type: item.type as MessageAttachment['type'],
      data: item.data,
    }
  })
}

function attachmentCharacterCount(attachments?: MessageAttachment[]): number {
  if (!attachments?.length) return 0
  return attachments.reduce((sum, att) => sum + att.data.length + att.name.length, 0)
}

function requireArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`Invalid ${label}`)
  return value
}

function requireNonEmptyString(value: unknown, label: string, maximum = 1_000): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new Error(`Invalid ${label}`)
  }
}

function requirePositiveInteger(value: unknown, label: string, maximum: number): asserts value is number {
  if (!Number.isInteger(value) || Number(value) <= 0 || Number(value) > maximum) {
    throw new Error(`Invalid ${label}`)
  }
}

function requireIsoDate(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`Invalid ${label}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export { sanitizeHeaders, sanitizeMcpHeaders, normalizeBaseUrl, sanitizeProviderRouting }
