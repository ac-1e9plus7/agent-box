import { Children, isValidElement, useEffect, useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { TokenUsage, WebCitation } from '../../../shared/types'
import type { ChatMessage, ModelConfig, PromptSuggestion } from '../types'
import { Icon } from './Icon'

interface ChatContentProps {
  messages: ChatMessage[]
  models: ModelConfig[]
  suggestions: PromptSuggestion[]
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
}: Pick<ChatContentProps, 'suggestions' | 'onSuggestion'>): JSX.Element {
  return (
    <div className="empty-conversation">
      <div className="welcome-mark"><Icon name="app" size={34} /></div>
      <p className="welcome-eyebrow">CHATBOX LITE</p>
      <h1>今天想聊点什么？</h1>
      <p className="welcome-subtitle">选择一个灵感，或直接在下方输入你的问题。</p>
      <div className="suggestion-grid">
        {suggestions.map((suggestion) => (
          <button key={suggestion.title} className="suggestion-card" onClick={() => onSuggestion(suggestion.prompt)}>
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

function AssistantMessage({ message, model }: { message: ChatMessage; model?: ModelConfig }): JSX.Element {
  const isStreaming = message.status === 'streaming'
  const reasoningUsage = reasoningUsageLabel(message.usage)
  const [reasoningOpen, setReasoningOpen] = useState(isStreaming)

  return (
    <article className="message-row assistant-message">
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
            <button onClick={() => navigator.clipboard?.writeText(message.content)}><Icon name="copy" size={14} /> 复制</button>
          </div>
        )}
        {message.status === 'error' && (
          <div className="message-error"><Icon name="info" size={15} /> {message.error || '请求失败，请检查服务商与模型配置。'}</div>
        )}
      </div>
    </article>
  )
}

export function ChatContent({ messages, models, suggestions, onSuggestion }: ChatContentProps): JSX.Element {
  const endRef = useRef<HTMLDivElement>(null)

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
            return (
              <AssistantMessage
                key={message.id}
                message={message}
                model={models.find((model) => model.id === message.modelId)}
              />
            )
          }

          return (
            <article className="message-row user-message" key={message.id}>
              <div className="message-column">
                <div className="user-bubble"><MessageBody content={message.content} /></div>
                <div className="user-message-time">{formatTime(message.createdAt)}</div>
              </div>
              <div className="message-avatar user-avatar"><Icon name="user" size={17} /></div>
            </article>
          )
        })}
        <div ref={endRef} />
      </div>
    </div>
  )
}
