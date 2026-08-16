import { Children, isValidElement, useEffect, useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getMessageSiblings } from '../../../shared/conversation-tree'
import type { MessageAttachment, TokenUsage, WebCitation } from '../../../shared/types'
import type { ChatMessage, ModelConfig, PromptSuggestion } from '../types'
import { formatFileSize } from '../file-helper'
import { Icon } from './Icon'

interface ChatContentProps {
  messages: ChatMessage[]
  allMessages?: ChatMessage[]
  models: ModelConfig[]
  streaming: boolean
  suggestions: PromptSuggestion[]
  onDeleteMessage?: (messageId: string) => void
  onEditMessage: (messageId: string, content: string, regenerate: boolean) => Promise<boolean>
  onRegenerate: (messageId?: string) => void
  onSwitchVersion?: (messageId: string) => void
  onSuggestion: (prompt: string) => void
}

function formatTime(timestamp: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(timestamp))
}

function compactTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 ? 1 : 0)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value % 1_000 ? 1 : 0)}K`
  return value.toLocaleString('zh-CN')
}

function reasoningUsageLabel(usage?: TokenUsage): string {
  if (usage?.reasoningTokens !== undefined) return `推理 ${compactTokenCount(usage.reasoningTokens)} tokens`
  if (usage?.totalTokens !== undefined) return `共 ${compactTokenCount(usage.totalTokens)} tokens`
  return ''
}

function safeCitationUrl(value: string): URL | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : undefined
  } catch {
    return undefined
  }
}

function CitationSources({ citations, usage }: { citations?: WebCitation[]; usage?: TokenUsage }): JSX.Element | null {
  const safeCitations = (citations ?? []).flatMap((citation) => {
    const url = safeCitationUrl(citation.url)
    return url ? [{ citation, url }] : []
  })
  const searchRequests = usage?.webSearchRequests ?? 0
  if (safeCitations.length === 0 && searchRequests <= 0) return null

  return (
    <section
      className="message-sources"
      aria-label={safeCitations.length > 0 ? `已联网 ${safeCitations.length} 个来源` : `已搜索 ${searchRequests} 次`}
    >
      <div className="message-sources-heading">
        <span>
          <Icon name="globe" size={14} />
          {safeCitations.length > 0 ? `已联网 ${safeCitations.length} 个来源` : `已搜索 ${searchRequests} 次`}
        </span>
        {safeCitations.length > 0 && searchRequests > 0 && <small>搜索 {searchRequests} 次</small>}
      </div>
      {safeCitations.length > 0 ? (
        <div className="message-source-list">
          {safeCitations.map(({ citation, url }, index) => (
            <a href={url.href} key={url.href} rel="noopener noreferrer" target="_blank">
              <span className="source-index">{index + 1}</span>
              <span className="source-copy">
                <strong>{citation.title?.trim() || url.hostname}</strong>
                <small>{citation.content?.trim() || url.hostname}</small>
              </span>
              <Icon name="external" size={13} />
            </a>
          ))}
        </div>
      ) : (
        <p className="message-sources-empty">搜索服务未返回可展示的结构化来源。</p>
      )}
    </section>
  )
}

function textFromNode(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textFromNode).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return textFromNode(node.props.children)
  return ''
}

function MessageBody({ content }: { content: string }): JSX.Element {
  return (
    <div className="message-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => <a {...props} rel="noopener noreferrer" target="_blank">{children}</a>,
          pre: ({ children }) => {
            const firstChild = Children.toArray(children)[0]
            const className = isValidElement<{ className?: string }>(firstChild) ? firstChild.props.className : undefined
            const language = className?.match(/language-([^\s]+)/)?.[1] ?? 'code'
            const code = textFromNode(children).replace(/\n$/, '')
            return (
              <div className="code-block">
              <div className="code-block-header">
                <span>{language}</span>
                <button aria-label="复制代码" onClick={() => navigator.clipboard?.writeText(code)}>
                  <Icon name="copy" size={14} />
                  复制
                </button>
              </div>
                <pre>{children}</pre>
              </div>
            )
          }
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

function EmptyConversation({
  suggestions,
  onSuggestion
}: {
  suggestions: PromptSuggestion[]
  onSuggestion: (prompt: string) => void
}): JSX.Element {
  return (
    <div className="empty-conversation">
      <div className="welcome-mark"><Icon name="app" size={34} /></div>
      <p className="welcome-eyebrow">AGENTBOX</p>
      <h1>今天想聊点什么？</h1>
      <p className="welcome-subtitle">选择一个灵感，或直接在下方输入你的问题。</p>
      <div className="suggestion-grid">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion.title}
            className="suggestion-card"
            onClick={() => onSuggestion(suggestion.prompt)}
          >
            <span className="suggestion-icon"><Icon name={suggestion.icon} size={18} /></span>
            <span>
              <strong>{suggestion.title}</strong>
              <small>{suggestion.description}</small>
            </span>
            <Icon className="suggestion-arrow" name="chevron-right" size={16} />
          </button>
        ))}
      </div>
    </div>
  )
}

function MessageAttachmentsView({
  attachments,
  onPreviewImage
}: {
  attachments?: MessageAttachment[]
  onPreviewImage: (url: string, name: string) => void
}): JSX.Element | null {
  if (!attachments || attachments.length === 0) return null

  return (
    <div className="message-attachments-group">
      {attachments.map((attachment) => {
        if (attachment.type === 'image' && attachment.data) {
          return (
            <button
              key={attachment.id}
              className="message-attachment-image-button"
              onClick={() => onPreviewImage(attachment.data, attachment.name)}
              title={`点击查看大图：${attachment.name}`}
            >
              <img alt={attachment.name} src={attachment.data} />
            </button>
          )
        }

        return (
          <div key={attachment.id} className="message-attachment-chip">
            <Icon name={attachment.type === 'image' ? 'image' : attachment.type === 'document' ? 'file' : 'code'} size={15} />
            <span className="attachment-chip-name" title={attachment.name}>{attachment.name}</span>
            <small className="attachment-chip-size">{formatFileSize(attachment.size)}</small>
          </div>
        )
      })}
    </div>
  )
}

function UserMessage({
  message,
  allMessages,
  canEdit,
  onDelete,
  onEdit,
  onSwitchVersion,
  onPreviewImage
}: {
  message: ChatMessage
  allMessages?: ChatMessage[]
  canEdit: boolean
  onDelete?: (messageId: string) => void
  onEdit: (messageId: string, content: string, regenerate: boolean) => Promise<boolean>
  onSwitchVersion?: (messageId: string) => void
  onPreviewImage: (url: string, name: string) => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)
  const { siblings, currentIndex, total } = getMessageSiblings(allMessages ?? [message], message.id)

  useEffect(() => {
    if (!editing) setDraft(message.content)
  }, [editing, message.content])

  const startEdit = (): void => {
    setDraft(message.content)
    setEditing(true)
  }
  const cancelEdit = (): void => {
    setDraft(message.content)
    setEditing(false)
  }
  const commitEdit = async (regenerate: boolean): Promise<void> => {
    const trimmed = draft.trim()
    if (!trimmed && !message.attachments?.length) return
    const ok = await onEdit(message.id, trimmed, regenerate)
    if (ok) setEditing(false)
  }

  if (editing) {
    return (
      <article className="message-row user-message">
        <div className="message-column">
          <div className="user-bubble user-bubble-editing">
            <textarea
              className="user-edit-input"
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelEdit()
                } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  void commitEdit(true)
                }
              }}
            />
            <div className="user-edit-actions">
              <button className="user-edit-cancel" onClick={cancelEdit}><Icon name="close" size={14} /> 取消</button>
              <button onClick={() => void commitEdit(false)}><Icon name="check" size={14} /> 仅保存</button>
              <button className="user-edit-regen" onClick={() => void commitEdit(true)}><Icon name="refresh" size={14} /> 保存并重新生成</button>
            </div>
          </div>
          <div className="user-message-time">{formatTime(message.createdAt)}</div>
        </div>
        <div className="message-avatar user-avatar"><Icon name="user" size={17} /></div>
      </article>
    )
  }

  return (
    <article className="message-row user-message">
      <div className="message-column">
        <MessageAttachmentsView attachments={message.attachments} onPreviewImage={onPreviewImage} />
        {Boolean(message.content.trim()) && (
          <div className="user-bubble"><MessageBody content={message.content} /></div>
        )}
        {(total > 1 || canEdit) && (
          <div className="user-message-tools">
            {total > 1 && (
              <div className="message-pagination user-pagination">
                <button
                  aria-label="上一个提问版本"
                  className="pagination-arrow"
                  disabled={currentIndex === 0 || !canEdit}
                  onClick={() => {
                    const target = siblings[currentIndex - 1]
                    if (target) onSwitchVersion?.(target.id)
                  }}
                  title="上一个提问版本"
                >
                  <Icon name="chevron-left" size={13} />
                </button>
                <span className="pagination-label">{currentIndex + 1} / {total}</span>
                <button
                  aria-label="下一个提问版本"
                  className="pagination-arrow"
                  disabled={currentIndex === total - 1 || !canEdit}
                  onClick={() => {
                    const target = siblings[currentIndex + 1]
                    if (target) onSwitchVersion?.(target.id)
                  }}
                  title="下一个提问版本"
                >
                  <Icon name="chevron-right" size={13} />
                </button>
              </div>
            )}
            {canEdit && (
              <>
                <button onClick={startEdit}><Icon name="edit" size={14} /> 编辑</button>
                <button onClick={() => onDelete?.(message.id)} title={total > 1 ? '删除当前提问版本及后续' : '删除此提问及后续'}><Icon name="trash" size={14} /> 删除</button>
              </>
            )}
          </div>
        )}
        <div className="user-message-time">{formatTime(message.createdAt)}</div>
      </div>
      <div className="message-avatar user-avatar"><Icon name="user" size={17} /></div>
    </article>
  )
}

function AssistantMessage({
  message,
  allMessages,
  model,
  canRegenerate,
  onDelete,
  onRegenerate,
  onSwitchVersion
}: {
  message: ChatMessage
  allMessages?: ChatMessage[]
  model?: ModelConfig
  canRegenerate: boolean
  onDelete?: (messageId: string) => void
  onRegenerate: (messageId?: string) => void
  onSwitchVersion?: (messageId: string) => void
}): JSX.Element {
  const isStreaming = message.status === 'streaming'
  const reasoningUsage = reasoningUsageLabel(message.usage)
  const [reasoningOpen, setReasoningOpen] = useState(isStreaming)
  const showRegenerate = canRegenerate && !isStreaming
  const { siblings, currentIndex, total } = getMessageSiblings(allMessages ?? [message], message.id)

  return (
    <article className={`message-row assistant-message${isStreaming ? ' is-streaming' : ''}`}>
      <div className="message-avatar assistant-avatar"><Icon name="app" size={18} /></div>
      <div className="message-column">
        <div className="message-meta">
          <strong>{model?.name ?? 'AI 助手'}</strong>
          <span>{formatTime(message.createdAt)}</span>
          {isStreaming && <span className="streaming-label"><i /> 正在生成</span>}
        </div>
        {message.reasoning && (
          <details
            className="reasoning-block"
            open={reasoningOpen}
            onToggle={(event) => setReasoningOpen(event.currentTarget.open)}
          >
            <summary>
              <span>
                <Icon name="brain" size={15} />
                {isStreaming ? '思考中…' : '已思考'}
                {reasoningUsage && <small>· {reasoningUsage}</small>}
              </span>
              <Icon className="reasoning-chevron" name="chevron-down" size={14} />
            </summary>
            <div>{message.reasoning}</div>
          </details>
        )}
        {!message.reasoning && (message.usage?.reasoningTokens ?? 0) > 0 && (
          <div className="reasoning-status" role="status">
            <Icon name="brain" size={15} />
            <span>
              <strong>已推理 {compactTokenCount(message.usage?.reasoningTokens ?? 0)} tokens</strong>
              <small>模型未返回可见思考过程</small>
            </span>
          </div>
        )}
        {message.content.trim() ? <MessageBody content={message.content} /> : isStreaming ? (
          <div className="typing-indicator" aria-label="正在回复"><i /><i /><i /></div>
        ) : message.status !== 'error' && (message.citations?.length ?? 0) > 0 ? (
          <div className="message-empty-response" role="status">
            <Icon name="info" size={15} />
            模型已执行搜索并返回来源，但没有生成正文；可重试或换用更适合工具调用的模型。
          </div>
        ) : null}
        <CitationSources citations={message.citations} usage={message.usage} />
        {!isStreaming && message.status !== 'error' && Boolean(message.content.trim()) && (
          <div className="message-tools">
            {total > 1 && (
              <div className="message-pagination">
                <button
                  aria-label="上一个回答"
                  className="pagination-arrow"
                  disabled={currentIndex === 0 || isStreaming}
                  onClick={() => {
                    const target = siblings[currentIndex - 1]
                    if (target) onSwitchVersion?.(target.id)
                  }}
                  title="上一个回答"
                >
                  <Icon name="chevron-left" size={13} />
                </button>
                <span className="pagination-label">{currentIndex + 1} / {total}</span>
                <button
                  aria-label="下一个回答"
                  className="pagination-arrow"
                  disabled={currentIndex === total - 1 || isStreaming}
                  onClick={() => {
                    const target = siblings[currentIndex + 1]
                    if (target) onSwitchVersion?.(target.id)
                  }}
                  title="下一个回答"
                >
                  <Icon name="chevron-right" size={13} />
                </button>
              </div>
            )}
            <button onClick={() => navigator.clipboard?.writeText(message.content)}><Icon name="copy" size={14} /> 复制</button>
            {showRegenerate && (
              <button onClick={() => onRegenerate(message.id)}><Icon name="refresh" size={14} /> 重新生成</button>
            )}
            {!isStreaming && (
              <button onClick={() => onDelete?.(message.id)} title={total > 1 ? '删除当前回答版本及后续' : '删除此回答及后续'}><Icon name="trash" size={14} /> 删除</button>
            )}
            <div className="message-model-info">
              <Icon name="app" size={14} /> {model?.name ?? message.modelId ?? '未知模型'} {message.usage?.outputTokens ? `(${message.usage.outputTokens} tokens)` : ''}
            </div>
          </div>
        )}
        {message.status === 'error' && (
          <div className="message-error">
            <Icon name="info" size={15} /> {message.error || '请求失败，请检查服务商与模型配置。'}
            {total > 1 && (
              <div className="message-pagination">
                <button
                  aria-label="上一个回答"
                  className="pagination-arrow"
                  disabled={currentIndex === 0}
                  onClick={() => {
                    const target = siblings[currentIndex - 1]
                    if (target) onSwitchVersion?.(target.id)
                  }}
                  title="上一个回答"
                >
                  <Icon name="chevron-left" size={13} />
                </button>
                <span className="pagination-label">{currentIndex + 1} / {total}</span>
                <button
                  aria-label="下一个回答"
                  className="pagination-arrow"
                  disabled={currentIndex === total - 1}
                  onClick={() => {
                    const target = siblings[currentIndex + 1]
                    if (target) onSwitchVersion?.(target.id)
                  }}
                  title="下一个回答"
                >
                  <Icon name="chevron-right" size={13} />
                </button>
              </div>
            )}
            {showRegenerate && (
              <button className="message-error-retry" onClick={() => onRegenerate(message.id)}>
                <Icon name="refresh" size={14} /> 重试
              </button>
            )}
            <button className="message-error-retry" onClick={() => onDelete?.(message.id)} title="删除此条错误信息">
              <Icon name="trash" size={14} /> 删除
            </button>
          </div>
        )}
      </div>
    </article>
  )
}

export function ChatContent({
  messages,
  allMessages,
  models,
  streaming,
  suggestions,
  onDeleteMessage,
  onEditMessage,
  onRegenerate,
  onSwitchVersion,
  onSuggestion
}: ChatContentProps): JSX.Element {
  const endRef = useRef<HTMLDivElement>(null)
  const [previewImage, setPreviewImage] = useState<{ url: string; name: string } | null>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: messages.some((message) => message.status === 'streaming') ? 'auto' : 'smooth' })
  }, [messages])

  if (messages.length === 0) {
    return <EmptyConversation suggestions={suggestions} onSuggestion={onSuggestion} />
  }

  return (
    <div className="chat-scroll-region">
      <div className="chat-thread">
        {messages.map((message) => {
          if (message.role === 'assistant') {
            const canRegenerate = !streaming
              && (message.status === 'complete' || message.status === 'error')
            return (
              <AssistantMessage
                key={message.id}
                message={message}
                allMessages={allMessages}
                model={models.find((model) => model.id === message.modelId)}
                canRegenerate={canRegenerate}
                onDelete={onDeleteMessage}
                onRegenerate={onRegenerate}
                onSwitchVersion={onSwitchVersion}
              />
            )
          }

          return (
            <UserMessage
              key={message.id}
              message={message}
              allMessages={allMessages}
              canEdit={!streaming}
              onDelete={onDeleteMessage}
              onEdit={onEditMessage}
              onSwitchVersion={onSwitchVersion}
              onPreviewImage={(url, name) => setPreviewImage({ url, name })}
            />
          )
        })}
        <div ref={endRef} />
      </div>

      {previewImage && (
        <div className="lightbox-overlay" onClick={() => setPreviewImage(null)}>
          <div className="lightbox-content" onClick={(event) => event.stopPropagation()}>
            <div className="lightbox-header">
              <span className="lightbox-title">{previewImage.name}</span>
              <button
                aria-label="关闭预览"
                className="icon-button"
                onClick={() => setPreviewImage(null)}
              >
                <Icon name="close" size={18} />
              </button>
            </div>
            <div className="lightbox-body">
              <img alt={previewImage.name} src={previewImage.url} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
