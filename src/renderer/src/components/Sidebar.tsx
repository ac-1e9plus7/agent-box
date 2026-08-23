import { useMemo, useState } from 'react'
import type { JSX } from 'react'
import type { Conversation } from '../types'
import { groupConversationsByWorkspace } from '../workspace-groups'
import { Icon } from './Icon'

interface SidebarProps {
  activeConversationId: string
  collapsed: boolean
  conversations: Conversation[]
  mobileOpen: boolean
  query: string
  onCloseMobile: () => void
  onCollapse: () => void
  onDeleteConversation: (conversationId: string) => void
  onNewConversation: () => void
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
  onCloseMobile,
  onCollapse,
  onDeleteConversation,
  onNewConversation,
  onOpenSettings,
  onQueryChange,
  onRenameConversation,
  onSelectConversation
}: SidebarProps): JSX.Element {
  const [editingId, setEditingId] = useState('')
  const [draftTitle, setDraftTitle] = useState('')

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
      {mobileOpen && <button className="sidebar-scrim" aria-label="关闭侧边栏" onClick={onCloseMobile} />}
      <aside
        className={`sidebar ${collapsed ? 'is-collapsed' : ''} ${mobileOpen ? 'is-mobile-open' : ''}`}
        aria-label="会话侧边栏"
      >
        <div className="sidebar-drag-region" />
        <div className="sidebar-header">
          <div className="brand" aria-label="AgentBox">
            <span className="brand-mark"><Icon name="app" size={22} /></span>
            <span className="brand-name">Agent<em>Box</em></span>
          </div>
          <button className="icon-button sidebar-collapse" aria-label="收起侧边栏" onClick={onCollapse}>
            <Icon name="sidebar" />
          </button>
        </div>

        <div className="sidebar-actions">
          <button className="new-chat-button" onClick={onNewConversation}>
            <Icon name="plus" size={17} />
            <span>新建对话</span>
            <kbd>⌘ N</kbd>
          </button>
          <label className="search-box">
            <Icon name="search" size={16} />
            <input
              aria-label="搜索会话"
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="搜索会话"
              type="search"
              value={query}
            />
          </label>
        </div>

        <nav className="conversation-nav" aria-label="会话历史">
          {groupedConversations.map((group) => (
            <section className="conversation-group" key={group.path || group.label}>
              <h2 title={group.path || '未设置工作目录'}><Icon name={group.path ? 'folder' : 'message'} size={12} /> {group.label}</h2>
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
                          aria-label="重命名会话"
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
                          aria-label={`重命名会话：${conversation.title}`}
                          onClick={() => startRename(conversation)}
                        >
                          <Icon name="edit" size={13} />
                        </button>
                      )}
                      <button
                        className="conversation-action conversation-delete"
                        aria-label={`删除会话：${conversation.title}`}
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
              <p>没有找到相关会话</p>
            </div>
          )}
        </nav>

        <footer className="sidebar-footer">
          <button className="sidebar-footer-button" onClick={onOpenSettings}>
            <span className="sidebar-footer-icon"><Icon name="settings" size={17} /></span>
            <span className="sidebar-footer-copy">
              <strong>设置</strong>
              <small>模型、服务商与数据</small>
            </span>
            <Icon name="chevron-right" size={15} />
          </button>
          <div className="local-data-note">
            <Icon name="lock" size={13} />
            <span>数据已在本机加密</span>
          </div>
        </footer>
      </aside>
    </>
  )
}
