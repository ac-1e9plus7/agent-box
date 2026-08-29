import { vi } from 'vitest'
import type {
  AgentboxAPI,
  AppSettings,
  Conversation,
  McpServerConfig,
  McpToolDefinition,
  ModelConfig,
  ProviderView,
  Skill,
  StreamEvent,
} from '../src/shared/types'
import { DEFAULT_BROWSER_HOME_PAGE } from '../src/shared/browser-settings'

const now = '2026-08-23T00:00:00.000Z'

export const rendererSettings: AppSettings = {
  language: 'zh-CN',
  theme: 'system',
  sendShortcut: 'enter',
  userNickname: '',
  userAvatar: '',
  defaultModelId: 'model-1',
  defaultReasoningEnabled: false,
  defaultReasoningEffort: 'medium',
  defaultAgentMode: false,
  agentToolTurnLimit: 30,
  agentToolResultCompactionEnabled: false,
  agentToolResultMaxCharacters: 16_000,
  agentDynamicToolExposureEnabled: false,
  agentDynamicToolLimit: 4,
  agentLazySkillResourcesEnabled: false,
  agentContextCompactionEnabled: false,
  agentContextCompactionThresholdPercent: 70,
  agentContextCompactionKeepRecentTurns: 3,
  agentProviderContextOptimizationMode: 'off',
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
  contextManagementMode: 'manual',
  systemPrompt: '',
  proxy: { mode: 'off', url: '' },
  integratedTerminalShell: { mode: 'auto', executable: '', args: [] },
  defaultWorkingDirectory: 'C:\\workspace',
  developerRuntimes: {
    jdk: { mode: 'auto', home: '' },
    go: { mode: 'auto', executable: '', root: '' },
    php: { mode: 'auto', executable: '' },
    python: { mode: 'auto', executable: '', environment: '', condaExecutable: 'conda' },
  },
}

export const rendererProvider: ProviderView = {
  id: 'provider-1',
  name: '测试服务商',
  kind: 'openai',
  baseUrl: 'https://example.test/v1',
  apiFormat: 'openai-responses',
  hasApiKey: true,
  apiKeyOptional: false,
  defaultHeaders: {},
  createdAt: now,
  updatedAt: now,
}

export const rendererModel: ModelConfig = {
  id: 'model-1',
  name: '测试模型',
  providerId: rendererProvider.id,
  remoteId: 'test/model',
  apiFormat: 'openai-responses',
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
  supportsReasoning: false,
  defaultReasoningEnabled: false,
  defaultReasoningEffort: 'medium',
  defaultWebSearchMode: 'off',
  anthropicThinkingMode: 'adaptive',
  createdAt: now,
  updatedAt: now,
}

export const rendererConversation: Conversation = {
  id: 'conversation-1',
  title: '已有会话',
  modelId: rendererModel.id,
  reasoningEnabled: false,
  agentMode: false,
  workingDirectory: 'C:\\workspace',
  webSearchMode: 'off',
  messages: [
    {
      id: 'user-1',
      role: 'user',
      content: '已有问题',
      parentMessageId: null,
      createdAt: now,
    },
    {
      id: 'assistant-1',
      role: 'assistant',
      content: '已有回答',
      parentMessageId: 'user-1',
      createdAt: now,
    },
  ],
  currentLeafId: 'assistant-1',
  createdAt: now,
  updatedAt: now,
}

export interface RendererApiMock {
  api: AgentboxAPI
  emit: (event: StreamEvent) => void
  mocks: {
    conversationSave: ReturnType<typeof vi.fn>
    stream: ReturnType<typeof vi.fn>
  }
}

export function createRendererApiMock({
  conversations = [rendererConversation],
  mcpServers = [],
  mcpTools = [],
  models = [rendererModel],
  providers = [rendererProvider],
  settings = rendererSettings,
  skills = [],
}: {
  conversations?: Conversation[]
  mcpServers?: McpServerConfig[]
  mcpTools?: McpToolDefinition[]
  models?: ModelConfig[]
  providers?: ProviderView[]
  settings?: AppSettings
  skills?: Skill[]
} = {}): RendererApiMock {
  let listener: ((event: StreamEvent) => void) | undefined
  const conversationSave = vi.fn(async (conversation: Conversation) => conversation)
  const stream = vi.fn(async () => ({ requestId: 'request-1' }))

  const api = {
    settings: {
      get: vi.fn(async () => settings),
      update: vi.fn(async (patch: Partial<AppSettings>) => ({ ...settings, ...patch })),
    },
    providers: {
      list: vi.fn(async () => providers),
      upsert: vi.fn(async () => providers[0]!),
      remove: vi.fn(async () => undefined),
      test: vi.fn(async () => ({ ok: true, latencyMs: 1, message: 'ok' })),
    },
    models: {
      list: vi.fn(async () => models),
      upsert: vi.fn(async () => models[0]!),
      remove: vi.fn(async () => undefined),
      discover: vi.fn(async () => []),
    },
    skills: {
      list: vi.fn(async () => skills),
      upsert: vi.fn(async (input: Skill) => input),
      remove: vi.fn(async () => undefined),
      toggle: vi.fn(async (id: string, enabled: boolean) => ({ ...skills.find((skill) => skill.id === id)!, enabled })),
      resetDefaults: vi.fn(async () => skills),
    },
    mcp: {
      listServers: vi.fn(async () => mcpServers),
      upsertServer: vi.fn(async (input: McpServerConfig) => input),
      removeServer: vi.fn(async () => undefined),
      toggleServer: vi.fn(async (id: string, enabled: boolean) => ({
        ...mcpServers.find((server) => server.id === id)!,
        enabled,
      })),
      testServer: vi.fn(async () => ({ ok: true, latencyMs: 1, toolsCount: 0, message: 'ok' })),
      listTools: vi.fn(async () => mcpTools),
    },
    terminal: {
      testShell: vi.fn(async () => ({ ok: true, platform: 'win32', latencyMs: 1, message: 'ok' })),
    },
    workspace: {
      getDefaultDirectory: vi.fn(async () => 'C:\\AgentBox\\.default-agent-box-workspace'),
      selectDirectory: vi.fn(async () => 'C:\\workspace'),
    },
    runtimes: {
      test: vi.fn(async (kind: 'jdk' | 'go' | 'php' | 'python') => ({ kind, ok: true, message: 'ok' })),
      listCondaEnvironments: vi.fn(async (condaExecutable: string) => ({
        ok: true,
        condaExecutable,
        environments: [],
        message: 'ok',
      })),
    },
    conversations: {
      list: vi.fn(async () => conversations),
      get: vi.fn(async (id: string) => conversations.find((conversation) => conversation.id === id)),
      save: conversationSave,
      remove: vi.fn(async () => undefined),
    },
    data: {
      exportBackup: vi.fn(async () => ({
        canceled: true,
        mode: 'shallow',
        encrypted: false,
        conversationCount: 0,
        workspaceCount: 0,
      })),
      clearConversations: vi.fn(async () => undefined),
    },
    chat: {
      stream,
      cancel: vi.fn(async () => undefined),
      resolveToolApproval: vi.fn(async () => undefined),
      onEvent: vi.fn((nextListener: (event: StreamEvent) => void) => {
        listener = nextListener
        return () => {
          if (listener === nextListener) listener = undefined
        }
      }),
    },
    browser: {
      ensure: vi.fn(async (conversationId: string) => browserState(conversationId, false)),
      navigate: vi.fn(async (conversationId: string, url: string) => ({
        ...browserState(conversationId, true),
        url,
        title: 'Test page',
      })),
      command: vi.fn(async (conversationId: string) => browserState(conversationId, true)),
      newTab: vi.fn(async (conversationId: string) => browserState(conversationId, true)),
      switchTab: vi.fn(async (conversationId: string) => browserState(conversationId, true)),
      closeTab: vi.fn(async (conversationId: string) => browserState(conversationId, true)),
      setViewState: vi.fn(async (input: { conversationId: string; visible: boolean }) =>
        browserState(input.conversationId, input.visible),
      ),
      close: vi.fn(async () => undefined),
      onEvent: vi.fn(() => () => undefined),
    },
    app: {
      getInfo: vi.fn(async () => ({ name: 'AgentBox', version: '0.1.0', platform: 'win32' })),
    },
  } as unknown as AgentboxAPI

  return {
    api,
    emit: (event) => listener?.(event),
    mocks: { conversationSave, stream },
  }
}

function browserState(conversationId: string, visible: boolean) {
  return {
    conversationId,
    sessionId: 'browser-test',
    phase: 'ready' as const,
    url: '',
    title: '',
    loading: false,
    visible,
    canGoBack: false,
    canGoForward: false,
    activeTabId: 'tab-test',
    tabs: [
      {
        id: 'tab-test',
        url: '',
        title: '',
        loading: false,
        canGoBack: false,
        canGoForward: false,
      },
    ],
  }
}
