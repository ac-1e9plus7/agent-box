import { useEffect, useMemo } from 'react'
import type { JSX } from 'react'
import type { Conversation } from '../types'
import { getNewConversationWorkspaceOptions } from '../workspace-groups'
import type { NewConversationWorkspaceOption } from '../workspace-groups'
import { Icon } from './Icon'

interface NewConversationDialogProps {
  busy?: boolean
  conversations: Conversation[]
  currentDirectory?: string
  defaultDirectory?: string
  onCancel: () => void
  onChooseDirectory: () => void
  onSelectWorkspace: (path: string) => void
}

function WorkspaceOptionButton({
  autoFocus,
  busy,
  option,
  onSelect,
}: {
  autoFocus?: boolean
  busy: boolean
  option: NewConversationWorkspaceOption
  onSelect: (path: string) => void
}): JSX.Element {
  const actionLabel = option.source === 'current'
    ? '沿用当前工作目录'
    : option.source === 'default'
      ? '使用默认工作目录'
      : option.label
  const meta = option.conversationCount > 0
    ? `${option.conversationCount} 个已有对话`
    : option.source === 'default'
      ? '设置中的默认目录'
      : '当前会话目录'

  return (
    <button
      aria-label={`${actionLabel}：${option.path}`}
      autoFocus={autoFocus}
      className={`workspace-choice-card is-${option.source}`}
      disabled={busy}
      onClick={() => onSelect(option.path)}
      title={option.path}
      type="button"
    >
      <span className="workspace-choice-icon"><Icon name="folder" size={17} /></span>
      <span className="workspace-choice-copy">
        <strong>{actionLabel}</strong>
        {option.source !== 'recent' && <span>{option.label}</span>}
        <small>{option.path}</small>
      </span>
      <span className="workspace-choice-meta">
        {option.source === 'current' && <em>推荐</em>}
        <small>{meta}</small>
        <Icon name="chevron-right" size={14} />
      </span>
    </button>
  )
}

export function NewConversationDialog({
  busy = false,
  conversations,
  currentDirectory,
  defaultDirectory,
  onCancel,
  onChooseDirectory,
  onSelectWorkspace,
}: NewConversationDialogProps): JSX.Element {
  const options = useMemo(() => getNewConversationWorkspaceOptions(
    conversations,
    currentDirectory,
    defaultDirectory,
  ), [conversations, currentDirectory, defaultDirectory])
  const featuredOptions = options.filter((option) => option.source !== 'recent')
  const recentOptions = options.filter((option) => option.source === 'recent').slice(0, 6)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [busy, onCancel])

  return (
    <div
      className="dialog-backdrop new-conversation-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel()
      }}
    >
      <section
        aria-labelledby="new-conversation-title"
        aria-modal="true"
        className="new-conversation-dialog"
        role="dialog"
      >
        <header className="new-conversation-header">
          <span className="new-conversation-mark"><Icon name="message" size={20} /></span>
          <span>
            <h2 id="new-conversation-title">新建对话</h2>
            <p>选择工作目录后开始，终端和项目操作都将以该目录为边界。</p>
          </span>
          <button aria-label="取消新建对话" className="icon-button" disabled={busy} onClick={onCancel} type="button">
            <Icon name="close" size={17} />
          </button>
        </header>

        <div className="new-conversation-body">
          {featuredOptions.length > 0 && (
            <div className="workspace-choice-list is-featured">
              {featuredOptions.map((option, index) => (
                <WorkspaceOptionButton
                  autoFocus={index === 0}
                  busy={busy}
                  key={`${option.source}:${option.path}`}
                  onSelect={onSelectWorkspace}
                  option={option}
                />
              ))}
            </div>
          )}

          {recentOptions.length > 0 && (
            <section className="recent-workspaces">
              <h3>最近使用</h3>
              <div className="workspace-choice-list">
                {recentOptions.map((option) => (
                  <WorkspaceOptionButton
                    busy={busy}
                    key={option.path}
                    onSelect={onSelectWorkspace}
                    option={option}
                  />
                ))}
              </div>
            </section>
          )}

          {options.length === 0 && (
            <div className="new-conversation-empty">
              <span><Icon name="folder" size={22} /></span>
              <strong>先选择一个项目目录</strong>
              <p>此设备上还没有可复用的工作目录。</p>
            </div>
          )}
        </div>

        <footer className="new-conversation-footer">
          <span><Icon name="shield" size={13} /> 只保存目录路径，不复制项目文件</span>
          <button autoFocus={options.length === 0} className="primary-button" disabled={busy} onClick={onChooseDirectory} type="button">
            <Icon name="folder" size={15} />
            {busy ? '正在创建…' : '选择其他目录'}
          </button>
        </footer>
      </section>
    </div>
  )
}
