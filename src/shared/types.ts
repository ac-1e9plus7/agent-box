export type ApiFormat = 'openai-chat-completions' | 'openai-responses' | 'anthropic-messages'

export type ProviderKind = 'openrouter' | 'openai' | 'anthropic' | 'cliproxy' | 'custom'

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type ThemeMode = 'system' | 'light' | 'dark'
export type ContextManagementMode = 'manual' | 'auto'
export type WebSearchMode = 'off' | 'auto' | 'native'

export interface BrowserViewBounds {
  x: number
  y: number
  width: number
  height: number
}

export type BrowserCommand = 'back' | 'forward' | 'reload' | 'stop'
export type BrowserSessionPhase = 'creating' | 'ready' | 'navigating' | 'failed' | 'closing'

export interface BrowserTabState {
  id: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  crashed?: boolean
}

export interface BrowserState {
  conversationId: string
  sessionId: string
  phase: BrowserSessionPhase
  url: string
  title: string
  loading: boolean
  visible: boolean
  canGoBack: boolean
  canGoForward: boolean
  activeTabId: string
  tabs: BrowserTabState[]
  error?: string
}

export interface BrowserDownloadEvent {
  conversationId: string
  tabId: string
  downloadId: string
  fileName: string
  receivedBytes: number
  totalBytes: number
  status: 'started' | 'progressing' | 'completed' | 'cancelled' | 'interrupted'
}

export type BrowserEvent = { type: 'state'; state: BrowserState } | { type: 'download'; download: BrowserDownloadEvent }

export interface BrowserCookieRecord {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  session: boolean
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
  expirationDate?: number
}

export interface BrowserCookieProfile {
  conversationId: string
  cookies: BrowserCookieRecord[]
  updatedAt: string
}

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

export type IntegratedTerminalShellMode = 'auto' | 'custom'

export interface IntegratedTerminalShellConfig {
  mode: IntegratedTerminalShellMode
  /** Executable name or absolute path. Used only in custom mode. */
  executable: string
  /** Additional arguments passed before the shell's command flag. */
  args: string[]
}

export interface TerminalShellTestResult {
  ok: boolean
  platform: string
  displayName?: string
  executable?: string
  latencyMs: number
  message: string
}

export type RuntimeSelectionMode = 'auto' | 'custom'

export interface DeveloperRuntimeSettings {
  jdk: { mode: RuntimeSelectionMode; home: string }
  go: { mode: RuntimeSelectionMode; executable: string; root: string }
  php: { mode: RuntimeSelectionMode; executable: string }
  python: {
    mode: 'auto' | 'system' | 'venv' | 'conda' | 'custom'
    executable: string
    environment: string
    condaExecutable: string
  }
}

export type DeveloperRuntimeKind = 'jdk' | 'go' | 'php' | 'python'

export interface RuntimeTestResult {
  kind: DeveloperRuntimeKind
  ok: boolean
  executable?: string
  version?: string
  message: string
}

export interface CondaEnvironment {
  name: string
  path: string
  active: boolean
}

export interface CondaEnvironmentListResult {
  ok: boolean
  condaExecutable: string
  environments: CondaEnvironment[]
  message: string
}

export type McpTransportType = 'stdio' | 'http' | 'sse'
export type McpToolRetrievalMode = 'auto' | 'all'
export type McpToolApprovalPolicy = 'always' | 'sensitive' | 'full-access'
export type ToolApprovalTimeoutMode = 'five-minutes' | 'never'
export type AgentProviderContextOptimizationMode = 'off' | 'auto' | 'prefix-cache' | 'native-continuation'

export type ToolApprovalDecision =
  { decision: 'deny' } | { decision: 'allow-once' } | { decision: 'allow-browser-origin' }

export type ToolApprovalKind = 'generic' | 'browser-navigation' | 'browser-share' | 'browser-interaction'

export interface BrowserApprovalScope {
  kind: 'browser-origin'
  origin: string
  capabilities: ['read']
}

export interface AppSettings {
  /** Persisted UI language. Missing legacy values migrate from the system locale. */
  language: import('./i18n').AppLanguage
  theme: ThemeMode
  sendShortcut: 'enter' | 'mod-enter'
  contextManagementMode: ContextManagementMode
  /** Local display-only profile fields; never included in model prompts. */
  userNickname?: string
  userAvatar?: string
  defaultModelId?: string
  titleGenerationModelId?: string
  defaultReasoningEnabled: boolean
  defaultReasoningEffort: Exclude<ReasoningEffort, 'none'>
  defaultAgentMode?: boolean
  /** Maximum consecutive tool-execution turns; defaults to 30 for legacy settings. */
  agentToolTurnLimit?: number
  /** Opt-in Agent token optimizations; missing legacy values normalize to conservative disabled defaults. */
  agentToolResultCompactionEnabled: boolean
  agentToolResultMaxCharacters: number
  agentDynamicToolExposureEnabled: boolean
  agentDynamicToolLimit: number
  agentLazySkillResourcesEnabled: boolean
  agentContextCompactionEnabled: boolean
  agentContextCompactionThresholdPercent: number
  agentContextCompactionKeepRecentTurns: number
  /** Provider-side Agent context reuse. Missing legacy values default to `off`. */
  agentProviderContextOptimizationMode: AgentProviderContextOptimizationMode
  /** Global opt-in for the isolated built-in browser. Missing legacy values default to disabled. */
  builtInBrowserEnabled: boolean
  /** Allows explicitly approved plain-HTTP loopback navigation for local development only. */
  browserAllowHttpLoopback: boolean
  /** Encrypt browser cookies in the Vault and restore them for the same conversation. */
  browserPersistCookiesEnabled: boolean
  /** Allow Agent tools to capture and send browser screenshots to vision-capable models. */
  browserAgentScreenshotsEnabled: boolean
  /** Allow Agent tools to upload workspace files into browser file inputs. */
  browserFileUploadsEnabled: boolean
  /** Allow browser downloads. Agent downloads remain scoped to the conversation workspace. */
  browserDownloadsEnabled: boolean
  mcpEnabled?: boolean
  mcpToolRetrievalMode?: McpToolRetrievalMode
  /** Defaults to `sensitive`: only explicitly read-only, closed-world tools run automatically. */
  mcpToolApprovalPolicy?: McpToolApprovalPolicy
  /** Defaults to `five-minutes`; `never` waits until the user decides or cancels the request. */
  toolApprovalTimeoutMode?: ToolApprovalTimeoutMode
  systemPrompt: string
  proxy: ProxyConfig
  integratedTerminalShell: IntegratedTerminalShellConfig
  defaultWorkingDirectory: string
  developerRuntimes: DeveloperRuntimeSettings
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
  clearEnv?: boolean
  url?: string
  headers?: Record<string, string>
  clearHeaders?: boolean
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
  /** Unique provider-safe name exposed to the model. */
  modelName?: string
  description?: string
  inputSchema: McpToolParameterSchema
  outputSchema?: McpToolParameterSchema
  annotations?: {
    title?: string
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
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

export interface ModelInput extends Omit<ModelConfig, 'id' | 'createdAt' | 'updatedAt'> {
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

export type AgentInterruptionReason =
  | 'rate_limit'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'tool_turn_limit'
  | 'output_limit'
  | 'api_error'
  | 'checkpoint_error'
  | 'unknown'

export interface AgentInterruption {
  reason: AgentInterruptionReason
  message: string
  occurredAt: string
  errorCode?: string
  status?: number
  retryAfterSeconds?: number
  finishReason?: string
}

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
  modelToolName?: string
  serverId?: string
  serverName?: string
  turn?: number
  args: Record<string, unknown>
  result?: string
  resultContent?: McpToolResultContent[]
  structuredResult?: Record<string, unknown>
  resultTruncated?: boolean
  isError?: boolean
  riskLevel?: 'low' | 'sensitive'
  approvalReason?: string
  approvalKind?: ToolApprovalKind
  approvalScope?: BrowserApprovalScope
  status: 'calling' | 'awaiting-approval' | 'executing' | 'complete' | 'denied' | 'error'
}

export type SkillActivationSource = 'automatic' | 'explicit' | 'model'

export interface SkillActivation {
  id: string
  name: string
  source: SkillActivationSource
  turn?: number
}

export type McpToolResultContent =
  | { type: 'text'; text: string }
  | { type: 'image' | 'audio'; data?: string; mimeType: string }
  | { type: 'resource'; uri: string; mimeType?: string; text?: string; blob?: string }
  | { type: 'resource_link'; uri: string; name: string; description?: string; mimeType?: string }

export type AgentTraceItem =
  | { type: 'assistant_text'; turn: number; text: string }
  | { type: 'assistant_thinking'; turn: number; blockIndex: number; thinking: string; signature?: string }
  | { type: 'provider_item'; turn: number; format: 'openai-responses'; item: Record<string, unknown> }
  | {
      type: 'tool_call'
      turn: number
      callId: string
      toolName: string
      modelToolName: string
      serverId?: string
      serverName?: string
      args: Record<string, unknown>
    }
  | {
      type: 'tool_result'
      turn: number
      callId: string
      toolName: string
      result: string
      resultContent?: McpToolResultContent[]
      structuredResult?: Record<string, unknown>
      resultTruncated?: boolean
      isError?: boolean
    }

export interface ProviderContinuation {
  format: 'openai-responses'
  responseId: string
  /** One-based model turn that produced this provider response. */
  turn: number
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
  /** Skills whose full instructions were loaded for this assistant response. */
  skillActivations?: SkillActivation[]
  toolExecutions?: ToolCallExecution[]
  /** Ordered protocol-neutral ledger used to replay multi-turn agent interactions. */
  agentTrace?: AgentTraceItem[]
  /** Opaque provider handle used only when native continuation is enabled. */
  providerContinuation?: ProviderContinuation
  /** Persisted checkpoint marker for an Agent response that can be resumed later. */
  interruption?: AgentInterruption
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
  /** Exposes the built-in browser tools to Agent mode for this conversation. */
  browserToolEnabled?: boolean
  skillIds?: string[]
  mcpServerIds?: string[]
  /**
   * Absolute local directory reference used as the filesystem and terminal scope.
   * Only this path string is persisted; project files are never copied into or encrypted by the vault.
   */
  workingDirectory?: string
  /** Defaults to off when omitted by an older vault. */
  webSearchMode?: WebSearchMode
  messages: Message[]
  currentLeafId?: string
  createdAt: string
  updatedAt: string
}

export interface ChatRequest {
  conversationId: string
  /** Renderer-created assistant response ID used to scope encrypted Agent checkpoints. */
  responseMessageId?: string
  modelId: string
  messages: Message[]
  reasoningEnabled: boolean
  agentMode?: boolean
  browserToolEnabled?: boolean
  skillIds?: string[]
  mcpServerIds?: string[]
  workingDirectory?: string
  /** Resume from the immediately preceding interrupted assistant checkpoint. */
  resumeFromMessageId?: string
  /** Overrides the model default for this request. */
  webSearchMode?: WebSearchMode
  /** Explicitly opts this one request into complete-turn trimming. */
  allowContextTrimming?: boolean
  reasoningEffort?: Exclude<ReasoningEffort, 'none'>
  maxOutputTokens?: number
  temperature?: number
}

export interface TokenUsageDetails {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cachedInputTokens?: number
  cacheWriteTokens?: number
  webSearchRequests?: number
  totalTokens?: number
}

export interface ModelRequestUsage extends TokenUsageDetails {
  /** One-based model turn within this assistant response. */
  turn: number
}

export interface TokenUsage extends TokenUsageDetails {
  /** Per-request usage retained so multi-turn Agent totals remain auditable. */
  modelRequests?: ModelRequestUsage[]
}

export interface ChatError {
  message: string
  code?: string
  status?: number
  retryAfterSeconds?: number
}

export type StreamEvent =
  | { type: 'start'; requestId: string }
  | { type: 'skill-activated'; requestId: string; skill: SkillActivation }
  | { type: 'text-delta'; requestId: string; delta: string; turn?: number }
  | {
      type: 'reasoning-delta'
      requestId: string
      delta: string
      turn?: number
      thinkingBlockIndex?: number
      signatureDelta?: string
    }
  | {
      type: 'agent-provider-item'
      requestId: string
      turn: number
      format: 'openai-responses'
      item: Record<string, unknown>
    }
  | {
      type: 'provider-continuation'
      requestId: string
      continuation: ProviderContinuation
    }
  | { type: 'citation'; requestId: string; citation: WebCitation }
  | {
      type: 'tool-call-start'
      requestId: string
      callId: string
      toolName: string
      modelToolName?: string
      serverName?: string
      turn?: number
    }
  | { type: 'tool-call-args'; requestId: string; callId: string; delta: string; turn?: number }
  | {
      type: 'tool-approval-required'
      requestId: string
      callId: string
      toolName: string
      modelToolName: string
      serverName?: string
      args: Record<string, unknown>
      riskLevel: 'low' | 'sensitive'
      reason: string
      approvalKind?: ToolApprovalKind
      approvalScope?: BrowserApprovalScope
      turn: number
    }
  | {
      type: 'tool-call-complete'
      requestId: string
      callId: string
      toolName: string
      modelToolName?: string
      args: Record<string, unknown>
      turn?: number
    }
  | {
      type: 'tool-result'
      requestId: string
      callId: string
      toolName: string
      result: string
      resultContent?: McpToolResultContent[]
      structuredResult?: Record<string, unknown>
      resultTruncated?: boolean
      isError?: boolean
      denied?: boolean
      turn?: number
    }
  | { type: 'usage'; requestId: string; turn: number; usage: TokenUsageDetails }
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

export type BackupMode = 'shallow' | 'deep'

export interface ExportBackupInput {
  mode: BackupMode
  /** Optional one-time password. It is never persisted by AgentBox. */
  password?: string
}

export interface ExportBackupResult {
  canceled: boolean
  filePath?: string
  mode: BackupMode
  encrypted: boolean
  conversationCount: number
  workspaceCount: number
  bytesWritten?: number
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
  terminal: {
    testShell(config: IntegratedTerminalShellConfig): Promise<TerminalShellTestResult>
  }
  workspace: {
    selectDirectory(initialPath?: string): Promise<string | undefined>
  }
  runtimes: {
    test(
      kind: DeveloperRuntimeKind,
      settings: DeveloperRuntimeSettings,
      workingDirectory?: string,
    ): Promise<RuntimeTestResult>
    listCondaEnvironments(condaExecutable: string): Promise<CondaEnvironmentListResult>
  }
  conversations: {
    list(): Promise<Conversation[]>
    get(id: string): Promise<Conversation | undefined>
    save(conversation: Conversation): Promise<Conversation>
    remove(id: string): Promise<void>
  }
  data: {
    /**
     * Exports every conversation as plaintext JSON and Markdown inside a ZIP.
     * Deep mode additionally includes all distinct conversation workspaces.
     */
    exportBackup(input: ExportBackupInput): Promise<ExportBackupResult>
    /**
     * Erases all conversations (chat history) while keeping provider, model and
     * settings configuration. Cancels any in-flight streams first.
     */
    clearConversations(): Promise<void>
  }
  chat: {
    stream(request: ChatRequest): Promise<{ requestId: string }>
    cancel(requestId: string): Promise<void>
    resolveToolApproval(requestId: string, callId: string, decision: ToolApprovalDecision): Promise<void>
    onEvent(listener: (event: StreamEvent) => void): () => void
  }
  browser: {
    ensure(conversationId: string): Promise<BrowserState>
    navigate(conversationId: string, url: string, tabId?: string): Promise<BrowserState>
    command(conversationId: string, command: BrowserCommand, tabId?: string): Promise<BrowserState>
    newTab(conversationId: string, url?: string): Promise<BrowserState>
    switchTab(conversationId: string, tabId: string): Promise<BrowserState>
    closeTab(conversationId: string, tabId: string): Promise<BrowserState>
    setViewState(input: { conversationId: string; visible: boolean; bounds: BrowserViewBounds }): Promise<BrowserState>
    close(conversationId: string): Promise<void>
    onEvent(listener: (event: BrowserEvent) => void): () => void
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
