export type ApiFormat =
  | 'openai-chat-completions'
  | 'openai-responses'
  | 'anthropic-messages'

export type ProviderKind =
  | 'openrouter'
  | 'openai'
  | 'anthropic'
  | 'cliproxy'
  | 'custom'

export type ReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

export type ThemeMode = 'system' | 'light' | 'dark'
export type ContextManagementMode = 'manual' | 'auto'
export type WebSearchMode = 'off' | 'auto' | 'native'

/** `off` connects directly; `custom` routes requests through the configured URL. */
export type ProxyMode = 'off' | 'custom'

export interface ProxyConfig {
  mode: ProxyMode
  /**
   * Proxy URL used when `mode === 'custom'`. Supports `http://` (loopback only)
   * and `https://` (any host); credentials may be embedded in the userinfo.
   * Empty when disabled.
   */
  url: string
}

export type McpTransportType = 'stdio' | 'sse'
export type McpToolRetrievalMode = 'auto' | 'all'

export interface AppSettings {
  theme: ThemeMode
  sendShortcut: 'enter' | 'mod-enter'
  contextManagementMode: ContextManagementMode
  defaultModelId?: string
  titleGenerationModelId?: string
  defaultReasoningEnabled: boolean
  defaultReasoningEffort: Exclude<ReasoningEffort, 'none'>
  defaultAgentMode?: boolean
  mcpEnabled?: boolean
  mcpToolRetrievalMode?: McpToolRetrievalMode
  systemPrompt: string
  proxy: ProxyConfig
}

export interface McpServerConfig {
  id: string
  name: string
  description?: string
  enabled: boolean
  transport: McpTransportType
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  createdAt: string
  updatedAt: string
}

export interface McpServerInput {
  id?: string
  name: string
  description?: string
  enabled?: boolean
  transport: McpTransportType
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

export interface McpToolParameterSchema {
  type: string
  properties?: Record<string, unknown>
  required?: string[]
  description?: string
  [key: string]: unknown
}

export interface McpToolDefinition {
  name: string
  description?: string
  inputSchema: McpToolParameterSchema
  serverId: string
  serverName: string
}

export interface McpServerTestResult {
  ok: boolean
  latencyMs: number
  toolsCount: number
  message: string
  tools?: McpToolDefinition[]
}

export type SkillFileKind = 'markdown' | 'python' | 'shell' | 'other'

export interface SkillFile {
  path: string
  content: string
  kind: SkillFileKind
}

export interface Skill {
  id: string
  name: string
  description: string
  icon?: string
  entryFile: string
  files: SkillFile[]
  systemPrompt?: string
  isBuiltIn?: boolean
  enabled: boolean
  author?: string
  version?: string
  createdAt?: string
  updatedAt?: string
}

export interface SkillInput {
  id?: string
  name: string
  description: string
  icon?: string
  entryFile?: string
  files?: SkillFile[]
  systemPrompt?: string
  enabled?: boolean
  author?: string
  version?: string
}

/** A provider object that is safe to expose to the renderer. */
export interface ProviderView {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  apiFormat: ApiFormat
  hasApiKey: boolean
  /** True only for a loopback CLIProxyAPI endpoint. */
  apiKeyOptional: boolean
  defaultHeaders: Record<string, string>
  createdAt: string
  updatedAt: string
}

/**
 * `apiKey` is write-only. Omit it to keep the existing key. Set
 * `clearApiKey` to explicitly remove it.
 */
export interface ProviderInput {
  id?: string
  name: string
  kind: ProviderKind
  baseUrl: string
  apiFormat: ApiFormat
  apiKey?: string
  clearApiKey?: boolean
  defaultHeaders?: Record<string, string>
}

export interface ProviderRouting {
  order?: string[]
  only?: string[]
  allowFallbacks?: boolean
  requireParameters?: boolean
  dataCollection?: 'allow' | 'deny'
  zdr?: boolean
  sort?: 'price' | 'throughput' | 'latency'
}

export interface ModelConfig {
  id: string
  name: string
  providerId: string
  remoteId: string
  /** Overrides the provider default for this model. */
  apiFormat?: ApiFormat
  contextWindow: number
  maxOutputTokens: number
  supportsReasoning: boolean
  defaultReasoningEnabled: boolean
  defaultReasoningEffort: Exclude<ReasoningEffort, 'none'>
  /** Defaults to off when omitted by an older vault. */
  defaultWebSearchMode?: WebSearchMode
  /** Adaptive is recommended for current Claude models; manual supports older models. */
  anthropicThinkingMode?: 'adaptive' | 'manual'
  providerRouting?: ProviderRouting
  createdAt: string
  updatedAt: string
}

export interface ModelInput
  extends Omit<ModelConfig, 'id' | 'createdAt' | 'updatedAt'> {
  id?: string
}

export interface RemoteModel {
  id: string
  name: string
  description?: string
  contextWindow?: number
  maxOutputTokens?: number
  supportsReasoning?: boolean
  supportedReasoningEfforts?: ReasoningEffort[]
}

export type MessageRole = 'system' | 'user' | 'assistant'

export type MessageAttachmentType = 'image' | 'document' | 'text'

export interface MessageAttachment {
  id: string
  name: string
  mimeType: string
  size: number
  /**
   * Data URL for images/documents (e.g. `data:image/png;base64,...` or `data:application/pdf;base64,...`)
   * or raw UTF-8 string for plain text files.
   */
  data: string
  type: MessageAttachmentType
}

export interface ToolCallExecution {
  id: string
  toolName: string
  serverId?: string
  serverName?: string
  args: Record<string, unknown>
  result?: string
  isError?: boolean
  status: 'calling' | 'executing' | 'complete' | 'error'
}

export interface Message {
  id: string
  role: MessageRole
  content: string
  parentMessageId?: string | null
  reasoning?: string
  citations?: WebCitation[]
  usage?: TokenUsage
  modelId?: string
  attachments?: MessageAttachment[]
  toolExecutions?: ToolCallExecution[]
  createdAt: string
}

export interface WebCitation {
  url: string
  title?: string
  content?: string
  startIndex?: number
  endIndex?: number
}

export interface Conversation {
  id: string
  title: string
  modelId: string
  reasoningEnabled?: boolean
  agentMode?: boolean
  skillIds?: string[]
  mcpServerIds?: string[]
  /** Defaults to off when omitted by an older vault. */
  webSearchMode?: WebSearchMode
  messages: Message[]
  currentLeafId?: string
  createdAt: string
  updatedAt: string
}

export interface ChatRequest {
  conversationId: string
  modelId: string
  messages: Message[]
  reasoningEnabled: boolean
  agentMode?: boolean
  skillIds?: string[]
  mcpServerIds?: string[]
  /** Overrides the model default for this request. */
  webSearchMode?: WebSearchMode
  /** Explicitly opts this one request into complete-turn trimming. */
  allowContextTrimming?: boolean
  reasoningEffort?: Exclude<ReasoningEffort, 'none'>
  maxOutputTokens?: number
  temperature?: number
}

export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  webSearchRequests?: number
  totalTokens?: number
}

export interface ChatError {
  message: string
  code?: string
  status?: number
  retryAfterSeconds?: number
}

export type StreamEvent =
  | { type: 'start'; requestId: string }
  | { type: 'text-delta'; requestId: string; delta: string }
  | { type: 'reasoning-delta'; requestId: string; delta: string }
  | { type: 'citation'; requestId: string; citation: WebCitation }
  | { type: 'tool-call-start'; requestId: string; callId: string; toolName: string; serverName?: string }
  | { type: 'tool-call-args'; requestId: string; callId: string; delta: string }
  | { type: 'tool-call-complete'; requestId: string; callId: string; toolName: string; args: Record<string, unknown> }
  | { type: 'tool-result'; requestId: string; callId: string; toolName: string; result: string; isError?: boolean }
  | { type: 'usage'; requestId: string; usage: TokenUsage }
  | { type: 'done'; requestId: string; finishReason?: string }
  | { type: 'error'; requestId: string; error: ChatError }

export interface ProviderTestResult {
  ok: boolean
  latencyMs: number
  message: string
}

export interface AppInfo {
  name: string
  version: string
  platform: string
}

export interface AgentboxAPI {
  settings: {
    get(): Promise<AppSettings>
    update(patch: Partial<AppSettings>): Promise<AppSettings>
  }
  providers: {
    list(): Promise<ProviderView[]>
    upsert(input: ProviderInput): Promise<ProviderView>
    remove(id: string): Promise<void>
    /** Tests a draft without persisting it; apiKey remains write-only. */
    test(input: ProviderInput): Promise<ProviderTestResult>
  }
  models: {
    list(): Promise<ModelConfig[]>
    upsert(input: ModelInput): Promise<ModelConfig>
    remove(id: string): Promise<void>
    discover(providerId: string): Promise<RemoteModel[]>
  }
  skills: {
    list(): Promise<Skill[]>
    upsert(input: SkillInput): Promise<Skill>
    remove(id: string): Promise<void>
    toggle(id: string, enabled: boolean): Promise<Skill>
    resetDefaults(): Promise<Skill[]>
  }
  mcp: {
    listServers(): Promise<McpServerConfig[]>
    upsertServer(input: McpServerInput): Promise<McpServerConfig>
    removeServer(id: string): Promise<void>
    toggleServer(id: string, enabled: boolean): Promise<McpServerConfig>
    testServer(input: McpServerInput): Promise<McpServerTestResult>
    listTools(serverId?: string): Promise<McpToolDefinition[]>
  }
  conversations: {
    list(): Promise<Conversation[]>
    get(id: string): Promise<Conversation | undefined>
    save(conversation: Conversation): Promise<Conversation>
    remove(id: string): Promise<void>
  }
  data: {
    /**
     * Erases all conversations (chat history) while keeping provider, model and
     * settings configuration. Cancels any in-flight streams first.
     */
    clearConversations(): Promise<void>
  }
  chat: {
    stream(request: ChatRequest): Promise<{ requestId: string }>
    cancel(requestId: string): Promise<void>
    onEvent(listener: (event: StreamEvent) => void): () => void
  }
  app: {
    getInfo(): Promise<AppInfo>
  }
}

declare global {
  interface Window {
    agentbox: AgentboxAPI
  }
}

export {}
