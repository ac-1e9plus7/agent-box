import { useState } from 'react'
import type { JSX } from 'react'
import type { ModelConfig, ProviderConfig } from '../types'
import { API_FORMAT_LABELS } from '../types'
import { Icon } from './Icon'

interface TopbarProps {
  activeModel?: ModelConfig
  activeTitle: string
  agentMode?: boolean
  enabledSkillsCount?: number
  selectedSkillsCount?: number
  models: ModelConfig[]
  providers: ProviderConfig[]
  reasoningEnabled: boolean
  sidebarCollapsed: boolean
  onModelChange: (modelId: string) => void
  onOpenMobileSidebar: () => void
  onOpenSettings: () => void
  onOpenSkillsSettings?: () => void
  onRenameConversation: (title: string) => void
  onRestoreSidebar: () => void
  onToggleAgentMode?: () => void
  onToggleReasoning: () => void
}

export function Topbar({
  activeModel,
  activeTitle,
  agentMode = false,
  enabledSkillsCount = 0,
  selectedSkillsCount = 0,
  models,
  providers,
  reasoningEnabled,
  sidebarCollapsed,
  onModelChange,
  onOpenMobileSidebar,
  onOpenSettings,
  onOpenSkillsSettings,
  onRenameConversation,
  onRestoreSidebar,
  onToggleAgentMode,
  onToggleReasoning
}: TopbarProps): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const provider = providers.find((item) => item.id === activeModel?.providerId)
  const reasoningSupported = activeModel?.supportsReasoning ?? false
  const effectiveFormat = activeModel?.apiFormat ?? provider?.apiFormat
  const reasoningLabel = !reasoningSupported
    ? '思考不可用'
    : reasoningEnabled
      ? `思考 · ${activeModel?.defaultReasoningEffort.toUpperCase()}`
      : '思考关闭'

  const startEdit = (): void => {
    setDraft(activeTitle)
    setEditing(true)
  }
  const commit = (): void => {
    onRenameConversation(draft)
    setEditing(false)
  }
  const cancel = (): void => {
    setEditing(false)
  }

  return (
    <header className="topbar">
      <div className="topbar-drag-region" />
      <div className="topbar-left">
        <button className="icon-button mobile-menu" aria-label="打开会话列表" onClick={onOpenMobileSidebar}>
          <Icon name="menu" />
        </button>
        {sidebarCollapsed && (
          <button className="icon-button restore-sidebar" aria-label="展开侧边栏" onClick={onRestoreSidebar}>
            <Icon name="sidebar" />
          </button>
        )}
        <div className="conversation-heading">
          {editing ? (
            <input
              autoFocus
              aria-label="重命名会话"
              className="topbar-title-input"
              value={draft}
              onBlur={commit}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commit()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  cancel()
                }
              }}
            />
          ) : (
            <button className="conversation-title-button" title="点击重命名" onClick={startEdit}>
              <strong>{activeTitle}</strong>
              <Icon name="edit" size={13} />
            </button>
          )}
          <span>{provider?.name ?? '未配置服务商'}</span>
        </div>
      </div>

      <div className="topbar-controls">
        <label className="model-select" title={activeModel ? `${activeModel.remoteId} · ${effectiveFormat ? API_FORMAT_LABELS[effectiveFormat] : '默认格式'}` : '选择模型'}>
          <span className="model-orb"><Icon name="sparkles" size={15} /></span>
          <span className="model-select-copy">
            <small>当前模型</small>
            <strong>{activeModel?.name ?? '选择模型'}</strong>
          </span>
          <Icon name="chevron-down" size={15} />
          <select
            aria-label="选择模型"
            onChange={(event) => onModelChange(event.target.value)}
            value={activeModel?.id ?? ''}
          >
            {models.map((model) => (
              <option key={model.id} value={model.id}>{model.name}</option>
            ))}
          </select>
        </label>
        <button
          className={`agent-header-button ${agentMode ? 'is-active' : ''}`}
          onClick={onToggleAgentMode}
          title={agentMode
            ? selectedSkillsCount > 0
              ? `Agent 模式已开启（本会话固定 ${selectedSkillsCount}/${enabledSkillsCount} 个技能）`
              : `Agent 模式已开启（${enabledSkillsCount} 个技能可用，本轮自动路由）`
            : '点击开启 Agent 智能体模式'}
        >
          <Icon name="bot" size={16} />
          <span>{agentMode ? `Agent 模式 (${selectedSkillsCount > 0 ? selectedSkillsCount : '自动'})` : 'Agent 模式'}</span>
          <span className="toggle-dot" />
        </button>
        <button
          className={`reasoning-header-button ${reasoningEnabled ? 'is-active' : ''}`}
          disabled={!reasoningSupported}
          onClick={onToggleReasoning}
          title={reasoningSupported ? '切换思考模式' : '当前模型不支持思考模式'}
        >
          <Icon name="brain" size={16} />
          <span>{reasoningLabel}</span>
          <span className="toggle-dot" />
        </button>
        <button className="icon-button topbar-settings" aria-label="打开设置" onClick={onOpenSettings}>
          <Icon name="settings" />
        </button>
      </div>
    </header>
  )
}
