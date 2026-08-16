import { randomUUID } from 'node:crypto'
import type {
  ApiFormat,
  AppSettings,
  Conversation,
  MessageAttachment,
  ModelConfig,
  ModelInput,
  ProviderInput,
  ProviderRouting,
  ProviderView,
  Skill,
  SkillFile,
  SkillFileKind,
  SkillInput,
} from '../../shared/types'
import { EncryptedStore } from './encrypted-store'
import { createOpenRouterAutoModel } from './default-models'
import { DEFAULT_SKILLS } from './default-skills'
import { normalizeAppSettings } from './settings-schema'
import { isApiKeyOptional, isLoopbackUrl } from '../api/provider-policy'
import { assertConversationMutationAllowed } from './vault-resource-limits'
import {
  citationCharacterCount,
  parseOptionalWebSearchMode,
  parseStoredCitations,
  parseStoredTokenUsage,
} from './web-metadata-schema'

export interface StoredProvider
  extends Omit<ProviderView, 'hasApiKey' | 'apiKeyOptional'> {
  apiKey?: string
}

export interface VaultState {
  schemaVersion: 1
  settings: AppSettings
  providers: StoredProvider[]
  models: ModelConfig[]
  conversations: Conversation[]
  skills?: Skill[]
}

const API_FORMATS = new Set<ApiFormat>([
  'openai-chat-completions',
  'openai-responses',
  'anthropic-messages',
])
const MAX_PROVIDERS = 100
const MAX_MODELS = 2_000
const MAX_CONVERSATIONS = 10_000
const MAX_SKILLS = 500
const MAX_MESSAGES_PER_CONVERSATION = 20_000
const MAX_MESSAGE_CHARACTERS = 2_000_000
const MAX_CONVERSATION_CHARACTERS = 50_000_000

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  sendShortcut: 'enter',
  contextManagementMode: 'manual',
  defaultModelId: 'openrouter-auto',
  defaultReasoningEnabled: false,
  defaultReasoningEffort: 'medium',
  defaultAgentMode: false,
  systemPrompt: '',
  proxy: { mode: 'off', url: '' },
}

export class AppRepository {
  private readonly store: EncryptedStore<VaultState>

  constructor(userDataDirectory: string) {
    this.store = new EncryptedStore(
      userDataDirectory,
      createDefaultVault,
      validateVault,
    )
  }

  initialize(): Promise<void> {
    return this.store.initialize()
  }

  destroy(): void {
    this.store.destroy()
  }

  getSettings(): AppSettings {
    return this.store.read().settings
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    return this.store.mutate((draft) => {
      const next = { ...draft.settings }
      if (patch.theme !== undefined) next.theme = patch.theme
      if (patch.sendShortcut !== undefined) next.sendShortcut = patch.sendShortcut
      if (patch.contextManagementMode !== undefined) {
        next.contextManagementMode = patch.contextManagementMode
      }
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
      if (patch.systemPrompt !== undefined) next.systemPrompt = patch.systemPrompt
      if (patch.proxy !== undefined) next.proxy = patch.proxy
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
      const existing = input.id
        ? draft.providers.find((provider) => provider.id === input.id)
        : undefined
      const provider = buildStoredProvider(input, existing)

      if (existing) {
        draft.providers = draft.providers.map((item) =>
          item.id === existing.id ? provider : item,
        )
      } else {
        draft.providers.push(provider)
      }
      return toProviderView(provider)
    })
  }

  async removeProvider(id: string): Promise<void> {
    return this.store.mutate((draft) => {
      if (draft.models.some((model) => model.providerId === id)) {
        throw new Error('该供应商仍被模型使用，请先删除或迁移相关模型。')
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
        throw new Error('模型引用的供应商不存在。')
      }

      const existing = input.id
        ? draft.models.find((model) => model.id === input.id)
        : undefined
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
        defaultWebSearchMode: parseOptionalWebSearchMode(
          input.defaultWebSearchMode,
          'model web search mode',
        ),
        anthropicThinkingMode: input.anthropicThinkingMode,
        providerRouting: sanitizeProviderRouting(input.providerRouting),
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      }
      validateModel(model)

      if (existing) {
        draft.models = draft.models.map((item) =>
          item.id === existing.id ? model : item,
        )
      } else {
        draft.models.push(model)
      }
      return structuredClone(model)
    })
  }

  async removeModel(id: string): Promise<void> {
    return this.store.mutate((draft) => {
      if (draft.conversations.some((conversation) => conversation.modelId === id)) {
        throw new Error('该模型仍被会话使用，请先删除会话或切换模型。')
      }
      draft.models = draft.models.filter((model) => model.id !== id)
      if (draft.settings.defaultModelId === id) {
        draft.settings.defaultModelId = draft.models[0]?.id
      }
    })
  }

  listSkills(): Skill[] {
    return structuredClone(this.store.read().skills ?? DEFAULT_SKILLS)
  }

  getSkill(id: string): Skill | undefined {
    return this.listSkills().find((skill) => skill.id === id)
  }

  async upsertSkill(input: SkillInput): Promise<Skill> {
    return this.store.mutate((draft) => {
      const skills = draft.skills ?? structuredClone(DEFAULT_SKILLS)
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
              kind: 'markdown'
            }
          ]
        } else if (existing?.files?.length) {
          files = existing.files
        } else {
          files = [
            {
              path: entryFile,
              content: `# ${input.name.trim()}\n\n${input.description.trim()}`,
              kind: 'markdown'
            }
          ]
        }
      }

      const systemPrompt = input.systemPrompt?.trim()
        || files.find((f) => f.path === entryFile)?.content
        || files[0]?.content
        || ''

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
      const validated = validateSkill(candidate)
      if (existing) {
        draft.skills = skills.map((item) => (item.id === validated.id ? validated : item))
      } else {
        if (skills.length >= MAX_SKILLS) throw new Error('Skill 数量已达上限。')
        draft.skills = [...skills, validated]
      }
      return structuredClone(validated)
    })
  }

  async removeSkill(id: string): Promise<void> {
    return this.store.mutate((draft) => {
      const skills = draft.skills ?? structuredClone(DEFAULT_SKILLS)
      const target = skills.find((skill) => skill.id === id)
      if (!target) return
      if (target.isBuiltIn) {
        throw new Error('系统预置技能不可删除，可以选择将其停用。')
      }
      draft.skills = skills.filter((skill) => skill.id !== id)
    })
  }

  async toggleSkill(id: string, enabled: boolean): Promise<Skill> {
    return this.store.mutate((draft) => {
      const skills = draft.skills ?? structuredClone(DEFAULT_SKILLS)
      const target = skills.find((skill) => skill.id === id)
      if (!target) throw new Error('技能不存在。')
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
      const nextSkills = [...structuredClone(DEFAULT_SKILLS), ...customSkills]
      draft.skills = nextSkills
      return structuredClone(nextSkills)
    })
  }

  listConversations(): Conversation[] {
    return this.store
      .read()
      .conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  getConversation(id: string): Conversation | undefined {
    return this.store.read().conversations.find((conversation) => conversation.id === id)
  }

  async saveConversation(conversation: Conversation): Promise<Conversation> {
    return this.store.mutate((draft) => {
      const validated = validateConversation(structuredClone(conversation))
      const existing = draft.conversations.some((item) => item.id === validated.id)
      if (existing) {
        const conversations = draft.conversations.map((item) =>
          item.id === validated.id ? validated : item,
        )
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
    return this.store.mutate((draft) => {
      draft.conversations = draft.conversations.filter(
        (conversation) => conversation.id !== id,
      )
    })
  }

  /**
   * Clears all conversations (chat history) while keeping providers, models and
   * settings intact. The vault is re-encrypted and rewritten in full so the
   * active file no longer contains any chat content; the master key is
   * preserved so the retained provider/model configuration stays readable.
   */
  async clearConversations(): Promise<void> {
    return this.store.mutate((draft) => {
      draft.conversations = []
    })
  }
}

function buildStoredProvider(
  input: ProviderInput,
  existing?: StoredProvider,
): StoredProvider {
  if (
    input.apiKey !== undefined &&
    (typeof input.apiKey !== 'string' || input.apiKey.length > 16_384)
  ) {
    throw new Error('API Key 无效或超过长度限制。')
  }
  const timestamp = new Date().toISOString()
  const normalizedBaseUrl = normalizeBaseUrl(input.baseUrl)
  const suppliedApiKey = input.apiKey?.trim()
  const canRetainExistingKey =
    existing?.baseUrl === normalizedBaseUrl && existing.kind === input.kind
  const provider: StoredProvider = {
    id: existing?.id ?? randomUUID(),
    name: input.name.trim(),
    kind: input.kind,
    baseUrl: normalizedBaseUrl,
    apiFormat: input.apiFormat,
    apiKey: input.clearApiKey
      ? undefined
      : suppliedApiKey || (canRetainExistingKey ? existing.apiKey : undefined),
    defaultHeaders: sanitizeHeaders(input.defaultHeaders ?? existing?.defaultHeaders ?? {}),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  }
  validateStoredProvider(provider)
  return provider
}

function createDefaultVault(): VaultState {
  const timestamp = new Date().toISOString()
  return {
    schemaVersion: 1,
    settings: structuredClone(DEFAULT_SETTINGS),
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
    skills: structuredClone(DEFAULT_SKILLS),
  }
}

function validateVault(value: unknown): VaultState {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('Unsupported vault schema')
  }
  const providers = requireArray(value.providers, 'providers', MAX_PROVIDERS).map(
    parseStoredProvider,
  )
  const models = requireArray(value.models, 'models', MAX_MODELS).map(parseModel)
  const conversations = requireArray(
    value.conversations,
    'conversations',
    MAX_CONVERSATIONS,
  ).map(validateConversation)
  const skills = value.skills !== undefined
    ? requireArray(value.skills, 'skills', MAX_SKILLS).map(validateSkill)
    : structuredClone(DEFAULT_SKILLS)
  return {
    schemaVersion: 1,
    settings: normalizeAppSettings(value.settings),
    providers,
    models,
    conversations,
    skills,
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
    (typeof value.apiKey !== 'string' ||
      !value.apiKey.trim() ||
      value.apiKey.length > 16_384)
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
    defaultWebSearchMode: parseOptionalWebSearchMode(
      value.defaultWebSearchMode,
      'model web search mode',
    ),
    anthropicThinkingMode: value.anthropicThinkingMode,
    providerRouting: sanitizeProviderRouting(value.providerRouting),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

const MAX_SKILL_FILES = 50
const MAX_SKILL_FILE_CHARACTERS = 500_000

function validateSkillFile(value: unknown): SkillFile {
  if (!isRecord(value)) throw new Error('Invalid skill file')
  requireNonEmptyString(value.path, 'skill file path', 255)
  const path = String(value.path).trim()
  if (path.includes('..') || path.startsWith('/') || path.startsWith('\\')) {
    throw new Error('Invalid skill file path: directory traversal not allowed')
  }
  if (typeof value.content !== 'string' || value.content.length > MAX_SKILL_FILE_CHARACTERS) {
    throw new Error(`Invalid skill file content: ${path}`)
  }
  const kind = ['markdown', 'python', 'shell', 'other'].includes(String(value.kind))
    ? (value.kind as SkillFileKind)
    : 'other'
  return {
    path,
    content: value.content,
    kind,
  }
}

function validateSkill(value: unknown): Skill {
  if (!isRecord(value)) throw new Error('Invalid skill')
  requireNonEmptyString(value.id, 'skill id', 100)
  requireNonEmptyString(value.name, 'skill name', 200)
  if (typeof value.description !== 'string' || value.description.length > 2_000) {
    throw new Error('Invalid skill description')
  }
  if (value.icon !== undefined && (typeof value.icon !== 'string' || value.icon.length > 50)) {
    throw new Error('Invalid skill icon')
  }
  const entryFile = typeof value.entryFile === 'string' && value.entryFile.trim()
    ? value.entryFile.trim()
    : 'SKILL.md'

  let files: SkillFile[] = []
  if (Array.isArray(value.files) && value.files.length > 0) {
    if (value.files.length > MAX_SKILL_FILES) throw new Error('Skill 包含的文件数量超过限制')
    files = value.files.map(validateSkillFile)
  } else if (typeof value.systemPrompt === 'string' && value.systemPrompt.trim()) {
    files = [
      {
        path: entryFile,
        content: value.systemPrompt.trim(),
        kind: 'markdown',
      },
    ]
  }

  const systemPrompt = typeof value.systemPrompt === 'string' && value.systemPrompt.trim()
    ? value.systemPrompt.trim()
    : files.find((f) => f.path === entryFile)?.content ?? files[0]?.content ?? ''

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
  const skillIds = Array.isArray(value.skillIds)
    ? value.skillIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()) && id.length <= 100)
    : undefined
  const webSearchMode = parseOptionalWebSearchMode(
    value.webSearchMode,
    'conversation web search mode',
  )
  const messages = requireArray(
    value.messages,
    'messages',
    MAX_MESSAGES_PER_CONVERSATION,
  ).map((message) => {
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
      (typeof message.reasoning !== 'string' ||
        message.reasoning.length > MAX_MESSAGE_CHARACTERS)
    ) {
      throw new Error('Invalid message reasoning')
    }
    requireIsoDate(message.createdAt, 'message createdAt')
    const citations = parseStoredCitations(message.citations)
    const usage = parseStoredTokenUsage(message.usage)
    const attachments = parseStoredAttachments(message.attachments)
    const parentMessageId =
      message.parentMessageId === null
        ? null
        : typeof message.parentMessageId === 'string' && message.parentMessageId.trim()
          ? message.parentMessageId.trim()
          : undefined
    return {
      id: message.id,
      role: message.role,
      content: message.content,
      parentMessageId,
      reasoning: message.reasoning,
      citations,
      usage,
      modelId: typeof message.modelId === 'string' && message.modelId.trim() ? message.modelId.trim() : undefined,
      attachments,
      createdAt: message.createdAt,
    } as Conversation['messages'][number]
  })
  const totalCharacters = messages.reduce(
    (sum, message) =>
      sum +
      message.content.length +
      (message.reasoning?.length ?? 0) +
      citationCharacterCount(message.citations) +
      attachmentCharacterCount(message.attachments),
    0,
  )
  if (totalCharacters > MAX_CONVERSATION_CHARACTERS) {
    throw new Error('Conversation is too large')
  }
  requireIsoDate(value.createdAt, 'conversation createdAt')
  requireIsoDate(value.updatedAt, 'conversation updatedAt')
  const currentLeafId =
    typeof value.currentLeafId === 'string' && value.currentLeafId.trim()
      ? value.currentLeafId.trim()
      : undefined
  return {
    id: value.id,
    title: value.title,
    modelId: value.modelId,
    reasoningEnabled: value.reasoningEnabled,
    agentMode: value.agentMode,
    skillIds,
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
  if (
    value.dataCollection !== undefined &&
    !['allow', 'deny'].includes(String(value.dataCollection))
  ) {
    throw new Error('Invalid provider data-collection setting')
  }
  if (
    value.sort !== undefined &&
    !['price', 'throughput', 'latency'].includes(String(value.sort))
  ) {
    throw new Error('Invalid provider sort setting')
  }
  return {
    order,
    only,
    allowFallbacks: value.allowFallbacks as boolean | undefined,
    requireParameters: value.requireParameters as boolean | undefined,
    dataCollection: value.dataCollection as ProviderRouting['dataCollection'],
    zdr: value.zdr as boolean | undefined,
    sort: value.sort as ProviderRouting['sort'],
  }
}

function sanitizeProviderSlugs(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 100) throw new Error(`Invalid ${label}`)
  return value.map((item) => {
    if (
      typeof item !== 'string' ||
      !item ||
      item.length > 100 ||
      !/^[0-9A-Za-z._/-]+$/.test(item)
    ) {
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
    throw new Error('供应商地址必须使用 http 或 https。')
  }
  if (url.protocol === 'http:' && !isLoopbackUrl(url.toString())) {
    throw new Error('远程供应商地址必须使用 HTTPS；HTTP 仅允许本机回环地址。')
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
      throw new Error(`不允许使用请求头：${name}`)
    }
    if (typeof rawValue !== 'string' || /[\r\n]/.test(rawValue) || rawValue.length > 4_096) {
      throw new Error(`请求头 ${name} 的值无效。`)
    }
    output[name] = rawValue
  }
  return output
}

function parseStoredAttachments(
  value: unknown,
): MessageAttachment[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error('Invalid message attachments')
  if (value.length > 20) throw new Error('Too many message attachments')
  if (value.length === 0) return undefined

  return value.map((item) => {
    if (!isRecord(item)) throw new Error('Invalid message attachment')
    requireNonEmptyString(item.id, 'attachment id', 120)
    requireNonEmptyString(item.name, 'attachment name', 300)
    requireNonEmptyString(item.mimeType, 'attachment mimeType', 100)
    if (
      typeof item.size !== 'number' ||
      !Number.isFinite(item.size) ||
      item.size < 0 ||
      item.size > 50 * 1024 * 1024
    ) {
      throw new Error('Invalid attachment size')
    }
    if (
      typeof item.type !== 'string' ||
      !['image', 'document', 'text'].includes(item.type)
    ) {
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
  return attachments.reduce(
    (sum, att) => sum + att.data.length + att.name.length,
    0,
  )
}

function requireArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`Invalid ${label}`)
  return value
}

function requireNonEmptyString(
  value: unknown,
  label: string,
  maximum = 1_000,
): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new Error(`Invalid ${label}`)
  }
}

function requirePositiveInteger(
  value: unknown,
  label: string,
  maximum: number,
): asserts value is number {
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

export {
  sanitizeHeaders,
  normalizeBaseUrl,
  sanitizeProviderRouting,
}

