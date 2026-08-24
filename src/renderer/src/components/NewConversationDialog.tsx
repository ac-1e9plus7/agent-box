import { useEffect, useMemo } from 'react'
import type { JSX } from 'react'
import type { Conversation } from '../types'
import { getNewConversationWorkspaceOptions } from '../workspace-groups'
import type { NewConversationWorkspaceOption } from '../workspace-groups'
import { Icon } from './Icon'
import { t } from "../../../shared/i18n"

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
    ? t("Keep current working directory")
    : option.source === 'default'
      ? t("Use default working directory")
      : option.label
  const meta = option.conversationCount > 0
    ? t("{value0} existing conversations", { value0: option.conversationCount })
    : option.source === 'default'
      ? t("Default directory from Settings")
      : t("Current conversation directory")

  return (
    <button
      aria-label={t("{value0}: {value1}", { value0: actionLabel, value1: option.path })}
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
        {option.source === 'current' && <em>{t("Recommended")}</em>}
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
            <h2 id="new-conversation-title">{t("New conversation")}</h2>
            <p>{t("Starting after selecting a working directory, terminal and project operations will be bounded by that directory.")}</p>
          </span>
          <button aria-label={t("Cancel new conversation")} className="icon-button" disabled={busy} onClick={onCancel} type="button">
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
              <h3>{t("Recently used")}</h3>
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
              <strong>{t("First select a project directory")}</strong>
              <p>{t("There is no reusable working directory on this device yet.")}</p>
            </div>
          )}
        </div>

        <footer className="new-conversation-footer">
          <span><Icon name="shield" size={13} />{t("Only the directory path is saved; project files are not copied")}</span>
          <button autoFocus={options.length === 0} className="primary-button" disabled={busy} onClick={onChooseDirectory} type="button">
            <Icon name="folder" size={15} />
            {busy ? t("Creating…") : t("Choose another directory")}
          </button>
        </footer>
      </section>
    </div>
  )
}
