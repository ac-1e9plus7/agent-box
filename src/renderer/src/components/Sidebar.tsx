import { useMemo, useState } from 'react'
import type { JSX } from 'react'
import type { Conversation } from '../types'
import { groupConversationsByWorkspace } from '../workspace-groups'
import { Icon } from './Icon'
import { t } from "../../../shared/i18n"

interface SidebarProps {
  activeConversationId: string
  collapsed: boolean
  conversations: Conversation[]
  mobileOpen: boolean
  query: string
  userAvatar?: string
  userNickname?: string
  onCloseMobile: () => void
  onCollapse: () => void
  onDeleteConversation: (conversationId: string) => void
  onNewConversation: () => void
  onNewConversationInWorkspace: (workingDirectory: string) => void
  onOpenSettings: () => void
  onQueryChange: (query: string) => void
  onRenameConversation: (conversationId: string, title: string) => void
  onSelectConversation: (conversationId: string) => void
}

export function Sidebar({
  activeConversationId,
  collapsed,
  conversations,
  mobileOpen,
  query,
  userAvatar,
  userNickname,
  onCloseMobile,
  onCollapse,
  onDeleteConversation,
  onNewConversation,
  onNewConversationInWorkspace,
  onOpenSettings,
  onQueryChange,
  onRenameConversation,
  onSelectConversation
}: SidebarProps): JSX.Element {
  const [editingId, setEditingId] = useState('')
  const [draftTitle, setDraftTitle] = useState('')
  const newConversationShortcut = /Mac|iPhone|iPad/i.test(navigator.platform) ? '⌘ N' : 'Ctrl N'

  const startRename = (conversation: Conversation): void => {
    setEditingId(conversation.id)
    setDraftTitle(conversation.title)
  }
  const commitRename = (): void => {
    if (editingId) onRenameConversation(editingId, draftTitle)
    setEditingId('')
    setDraftTitle('')
  }
  const cancelRename = (): void => {
    setEditingId('')
    setDraftTitle('')
  }

  const groupedConversations = useMemo(() => {
    return groupConversationsByWorkspace(conversations, query)
  }, [conversations, query])

  return (
    <>
      {mobileOpen && <button className="sidebar-scrim" aria-label={t("Close sidebar")} onClick={onCloseMobile} />}
      <aside
        className={`sidebar ${collapsed ? 'is-collapsed' : ''} ${mobileOpen ? 'is-mobile-open' : ''}`}
        aria-label={t("Conversation sidebar")}
      >
        <div className="sidebar-drag-region" />
        <div className="sidebar-header">
          <div className="brand" aria-label="AgentBox">
            <span className="brand-mark"><Icon name="app" size={22} /></span>
            <span className="brand-name">Agent<em>Box</em></span>
          </div>
          <button className="icon-button sidebar-collapse" aria-label={t("Collapse sidebar")} onClick={onCollapse}>
            <Icon name="sidebar" />
          </button>
        </div>

        <div className="sidebar-actions">
          <button className="new-chat-button" onClick={onNewConversation}>
            <Icon name="plus" size={17} />
            <span>{t("New conversation")}</span>
            <kbd>{newConversationShortcut}</kbd>
          </button>
          <label className="search-box">
            <Icon name="search" size={16} />
            <input
              aria-label={t("Search conversations")}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder={t("Search conversations")}
              type="search"
              value={query}
            />
          </label>
        </div>

        <nav className="conversation-nav" aria-label={t("Conversation history")}>
          {groupedConversations.map((group) => (
            <section className="conversation-group" key={group.path || group.label}>
              <div className="conversation-group-heading">
                <h2 title={group.path || t("No working directory set")}>
                  <Icon name={group.path ? 'folder' : 'message'} size={12} />
                  <span>{group.label}</span>
                </h2>
                {group.path && (
                  <button
                    aria-label={t("Create new conversation in {value0}", { value0: group.label })}
                    className="workspace-new-chat"
                    onClick={() => onNewConversationInWorkspace(group.path!)}
                    title={t("Create a new conversation based on {value0}", { value0: group.path })}
                    type="button"
                  >
                    <Icon name="plus" size={12} />
                  </button>
                )}
              </div>
              <div className="conversation-list">
                {group.conversations.map((conversation) => {
                  const isEditing = editingId === conversation.id
                  return (
                    <div
                      className={`conversation-item ${conversation.id === activeConversationId ? 'is-active' : ''}`}
                      key={conversation.id}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          aria-label={t("Rename conversation")}
                          className="conversation-rename-input"
                          value={draftTitle}
                          onBlur={commitRename}
                          onChange={(event) => setDraftTitle(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              commitRename()
                            } else if (event.key === 'Escape') {
                              event.preventDefault()
                              cancelRename()
                            }
                          }}
                        />
                      ) : (
                        <button
                          className="conversation-select"
                          onClick={() => onSelectConversation(conversation.id)}
                          title={conversation.title}
                        >
                          <Icon name="message" size={15} />
                          <span>{conversation.title}</span>
                        </button>
                      )}
                      {!isEditing && (
                        <button
                          className="conversation-action conversation-rename"
                          aria-label={t("Rename conversation: {value0}", { value0: conversation.title })}
                          onClick={() => startRename(conversation)}
                        >
                          <Icon name="edit" size={13} />
                        </button>
                      )}
                      <button
                        className="conversation-action conversation-delete"
                        aria-label={t("Delete conversation: {value0}", { value0: conversation.title })}
                        onClick={() => onDeleteConversation(conversation.id)}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  )
                })}
              </div>
            </section>
          ))}
          {groupedConversations.length === 0 && (
            <div className="sidebar-empty">
              <Icon name="search" size={22} />
              <p>{t("No matching conversations found")}</p>
            </div>
          )}
        </nav>

        <footer className="sidebar-footer">
          <button className="sidebar-footer-button" onClick={onOpenSettings}>
            <span className={`sidebar-footer-icon ${userAvatar ? 'has-user-avatar' : ''}`}>
              {userAvatar
                ? <img alt="" src={userAvatar} />
                : <Icon name="settings" size={17} />}
            </span>
            <span className="sidebar-footer-copy">
              <strong>{userNickname?.trim() || t("Settings")}</strong>
              <small>{userNickname?.trim() ? t("Profile and settings") : t("Models, providers, and data")}</small>
            </span>
            <Icon name="chevron-right" size={15} />
          </button>
          <div className="local-data-note">
            <Icon name="lock" size={13} />
            <span>{t("Data is encrypted locally")}</span>
          </div>
        </footer>
      </aside>
    </>
  )
}
