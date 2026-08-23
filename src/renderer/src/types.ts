import type {
  ApiFormat as SharedApiFormat,
  AppSettings,
  Conversation as StoredConversation,
  Message as StoredMessage,
  ModelConfig as StoredModelConfig,
  ProviderView,
  WebSearchMode as SharedWebSearchMode
} from '../../shared/types'
import { t } from '../../shared/i18n'

export type ApiFormat = SharedApiFormat
export type WebSearchMode = SharedWebSearchMode

export type SettingsSection = 'general' | 'runtimes' | 'skills' | 'mcp' | 'models' | 'providers' | 'security' | 'about'

export type MessageStatus = 'complete' | 'streaming' | 'error'

export interface ProviderConfig extends ProviderView {
  isBuiltIn?: boolean
}

export interface ProviderDraft extends ProviderConfig {
  apiKeyInput: string
}

export type ModelConfig = StoredModelConfig

export interface ChatMessage extends StoredMessage {
  error?: string
  modelId?: string
  status?: MessageStatus
}

export interface Conversation extends Omit<StoredConversation, 'messages'> {
  messages: ChatMessage[]
  agentMode?: boolean
  skillIds?: string[]
  mcpServerIds?: string[]
  pinned?: boolean
}

export type AppPreferences = AppSettings

export interface AppStateSnapshot {
  providers: ProviderConfig[]
  models: ModelConfig[]
  conversations: Conversation[]
  activeConversationId: string
  activeModelId: string
  reasoningEnabled: boolean
  webSearchMode: WebSearchMode
  preferences: AppPreferences
}

export interface PromptSuggestion {
  title: string
  description: string
  prompt: string
  icon: IconName
}

export type IconName =
  | 'app'
  | 'archive'
  | 'arrow-up'
  | 'bot'
  | 'brain'
  | 'chart'
  | 'check'
  | 'chevron-down'
  | 'chevron-left'
  | 'chevron-right'
  | 'close'
  | 'code'
  | 'copy'
  | 'database'
  | 'download'
  | 'edit'
  | 'external'
  | 'file'
  | 'folder'
  | 'globe'
  | 'image'
  | 'info'
  | 'key'
  | 'lock'
  | 'menu'
  | 'message'
  | 'minus'
  | 'more'
  | 'paperclip'
  | 'plus'
  | 'refresh'
  | 'search'
  | 'send'
  | 'settings'
  | 'shield'
  | 'sidebar'
  | 'sparkles'
  | 'sun'
  | 'tool'
  | 'translate'
  | 'trash'
  | 'upload'
  | 'user'
  | 'zap'

export const API_FORMAT_LABELS: Record<ApiFormat, string> = {
  'openai-chat-completions': t('apiFormat.openaiChatCompletions'),
  'openai-responses': t('apiFormat.openaiResponses'),
  'anthropic-messages': t('apiFormat.anthropicMessages')
}
