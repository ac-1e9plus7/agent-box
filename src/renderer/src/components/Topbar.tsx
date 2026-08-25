import { useState } from 'react'
import type { JSX } from 'react'
import type { ModelConfig, ProviderConfig } from '../types'
import { API_FORMAT_LABELS } from '../types'
import { Icon } from './Icon'
import { t } from '../../../shared/i18n'

interface TopbarProps {
  activeModel?: ModelConfig
  activeTitle: string
  agentMode?: boolean
  enabledSkillsCount?: number
  selectedSkillsCount?: number
  workingDirectory?: string
  models: ModelConfig[]
  providers: ProviderConfig[]
  reasoningEnabled: boolean
  sidebarCollapsed: boolean
  onModelChange: (modelId: string) => void
  onOpenMobileSidebar: () => void
  onOpenSettings: () => void
  onRenameConversation: (title: string) => void
  onRestoreSidebar: () => void
  onToggleAgentMode?: () => void
  onToggleReasoning: () => void
  onChangeWorkingDirectory?: () => void
}

export function Topbar({
  activeModel,
  activeTitle,
  agentMode = false,
  enabledSkillsCount = 0,
  selectedSkillsCount = 0,
  workingDirectory,
  models,
  providers,
  reasoningEnabled,
  sidebarCollapsed,
  onModelChange,
  onOpenMobileSidebar,
  onOpenSettings,
  onRenameConversation,
  onRestoreSidebar,
  onToggleAgentMode,
  onToggleReasoning,
  onChangeWorkingDirectory,
}: TopbarProps): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const provider = providers.find((item) => item.id === activeModel?.providerId)
  const reasoningSupported = activeModel?.supportsReasoning ?? false
  const effectiveFormat = activeModel?.apiFormat ?? provider?.apiFormat
  const reasoningLabel = !reasoningSupported
    ? t('Reasoning unavailable')
    : reasoningEnabled
      ? t('Reasoning · {value0}', { value0: activeModel?.defaultReasoningEffort.toUpperCase() })
      : t('Reasoning off')
  const workingDirectoryLabel = workingDirectory?.split(/[\\/]/).filter(Boolean).at(-1) || t('Select working directory')

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
        <button
          className="icon-button mobile-menu"
          aria-label={t('Open conversation list')}
          onClick={onOpenMobileSidebar}
        >
          <Icon name="menu" />
        </button>
        {sidebarCollapsed && (
          <button className="icon-button restore-sidebar" aria-label={t('Expand sidebar')} onClick={onRestoreSidebar}>
            <Icon name="sidebar" />
          </button>
        )}
        <div className="conversation-heading">
          {editing ? (
            <input
              autoFocus
              aria-label={t('Rename conversation')}
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
            <button className="conversation-title-button" title={t('Click to rename')} onClick={startEdit}>
              <strong>{activeTitle}</strong>
              <Icon name="edit" size={13} />
            </button>
          )}
          <span>{provider?.name ?? t('No provider configured')}</span>
          <div className="workspace-control">
            <button
              className={`workspace-directory-button ${workingDirectory ? 'has-directory' : ''}`}
              disabled={!onChangeWorkingDirectory}
              onClick={onChangeWorkingDirectory}
              title={workingDirectory || t('Choose a working directory for this conversation')}
              type="button"
            >
              <Icon name="folder" size={12} />
              <span>{workingDirectoryLabel}</span>
            </button>
          </div>
        </div>
      </div>

      <div className="topbar-controls">
        <label
          className="model-select"
          title={
            activeModel
              ? `${activeModel.remoteId} · ${effectiveFormat ? API_FORMAT_LABELS[effectiveFormat] : t('Default format')}`
              : t('Select model')
          }
        >
          <span className="model-orb">
            <Icon name="sparkles" size={15} />
          </span>
          <span className="model-select-copy">
            <small>{t('Current model')}</small>
            <strong>{activeModel?.name ?? t('Select model')}</strong>
          </span>
          <Icon name="chevron-down" size={15} />
          <select
            aria-label={t('Select model')}
            onChange={(event) => onModelChange(event.target.value)}
            value={activeModel?.id ?? ''}
          >
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className={`agent-header-button ${agentMode ? 'is-active' : ''}`}
          onClick={onToggleAgentMode}
          title={
            agentMode
              ? selectedSkillsCount > 0
                ? t('Agent mode is on ({value0} of {value1} Skills pinned for this conversation)', {
                    value0: selectedSkillsCount,
                    value1: enabledSkillsCount,
                  })
                : t('Agent mode is on ({value0} Skills available; routed automatically for this turn)', {
                    value0: enabledSkillsCount,
                  })
              : t('Click to enable Agent mode')
          }
        >
          <Icon name="bot" size={16} />
          <span>
            {agentMode
              ? t('Agent mode ({value0})', { value0: selectedSkillsCount > 0 ? selectedSkillsCount : t('Auto') })
              : t('Agent mode')}
          </span>
          <span className="toggle-dot" />
        </button>
        <button
          className={`reasoning-header-button ${reasoningEnabled ? 'is-active' : ''}`}
          disabled={!reasoningSupported}
          onClick={onToggleReasoning}
          title={reasoningSupported ? t('Toggle reasoning') : t('The current model does not support reasoning')}
        >
          <Icon name="brain" size={16} />
          <span>{reasoningLabel}</span>
          <span className="toggle-dot" />
        </button>
        <button className="icon-button topbar-settings" aria-label={t('Open settings')} onClick={onOpenSettings}>
          <Icon name="settings" />
        </button>
      </div>
    </header>
  )
}
