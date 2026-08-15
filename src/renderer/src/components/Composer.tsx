import { useEffect, useRef } from 'react'
import type { CSSProperties, JSX } from 'react'
import type { ModelConfig, WebSearchMode } from '../types'
import { WEB_SEARCH_MODE_LABELS } from '../web-search'
import { Icon } from './Icon'

interface ComposerProps {
  activeModel?: ModelConfig
  contextCanTrimOnce: boolean
  contextLimit: number
  contextMessage: string
  contextMode: 'manual' | 'auto'
  contextTone: 'ok' | 'warning' | 'error'
  contextTokens: number
  disabled?: boolean
  draft: string
  reasoningEnabled: boolean
  webSearchAvailable: boolean
  webSearchMode: WebSearchMode
  sendBlocked: boolean
  sendOnEnter: boolean
  onDraftChange: (draft: string) => void
  onOpenContextSettings: () => void
  onOpenModelSettings: () => void
  onSend: () => void
  onSendWithTrim: () => void
  onStop: () => void
  onToggleReasoning: () => void
  onWebSearchModeChange: (mode: WebSearchMode) => void
  streaming: boolean
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 ? 1 : 0)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value % 1_000 ? 1 : 0)}k`
  return String(value)
}

export function Composer({
  activeModel,
  contextCanTrimOnce,
  contextLimit,
  contextMessage,
  contextMode,
  contextTone,
  contextTokens,
  disabled,
  draft,
  reasoningEnabled,
  webSearchAvailable,
  webSearchMode,
  sendBlocked,
  sendOnEnter,
  onDraftChange,
  onOpenContextSettings,
  onOpenModelSettings,
  onSend,
  onSendWithTrim,
  onStop,
  onToggleReasoning,
  onWebSearchModeChange,
  streaming
}: ComposerProps): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const contextPercentage = contextLimit ? Math.min((contextTokens / contextLimit) * 100, 100) : 0
  const reasoningLabel = !activeModel?.supportsReasoning
    ? '思考不可用'
    : reasoningEnabled
      ? `思考 · ${activeModel.defaultReasoningEffort.toUpperCase()}`
      : '思考关闭'
  const webSearchLabel = !webSearchAvailable
    ? '联网不可用'
    : webSearchMode === 'off'
      ? '联网关闭'
      : WEB_SEARCH_MODE_LABELS[webSearchMode]
  const webSearchDescription = webSearchAvailable
    ? '联网搜索可能额外计费，并会将查询发送给搜索服务。“原生优先”不受支持时会自动回退。'
    : '当前仅 OpenRouter 连接支持联网搜索。'

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`
  }, [draft])

  return (
    <div className="composer-wrap">
      {contextMessage && (
        <div className={`context-notice is-${contextTone}`} role={contextTone === 'error' ? 'alert' : 'status'}>
          <Icon name={contextTone === 'error' ? 'info' : 'refresh'} size={15} />
          <span>{contextMessage}</span>
          {contextCanTrimOnce ? (
            <button onClick={onSendWithTrim}>本次裁剪并发送</button>
          ) : contextTone === 'error' ? (
            <button onClick={onOpenContextSettings}>上下文设置</button>
          ) : null}
        </div>
      )}
      <div className={`composer ${disabled ? 'is-disabled' : ''} ${contextTone === 'error' ? 'has-context-error' : ''}`}>
        <textarea
          ref={textareaRef}
          aria-label="消息输入框"
          disabled={disabled}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            const shouldSend = sendOnEnter
              ? event.key === 'Enter' && !event.shiftKey
              : event.key === 'Enter' && (event.metaKey || event.ctrlKey)
            if (shouldSend && !event.nativeEvent.isComposing) {
              event.preventDefault()
              onSend()
            }
          }}
          placeholder={disabled ? '请先配置可用模型与 API 密钥' : '给 ChatBox Lite 发送消息…'}
          rows={1}
          value={draft}
        />

        <div className="composer-toolbar">
          <div className="composer-tools-left">
            <button
              className={`reasoning-pill ${reasoningEnabled ? 'is-active' : ''}`}
              disabled={!activeModel?.supportsReasoning || disabled}
              onClick={onToggleReasoning}
              title={activeModel?.supportsReasoning ? '切换思考模式' : '当前模型不支持思考模式'}
            >
              <Icon name="brain" size={15} />
              {reasoningLabel}
              {reasoningEnabled && <Icon name="check" size={13} />}
            </button>
            <label
              className={`web-search-pill ${webSearchMode !== 'off' && webSearchAvailable ? 'is-active' : ''} ${!webSearchAvailable ? 'is-unavailable' : ''}`}
              title={webSearchDescription}
            >
              <Icon name="globe" size={15} />
              <span>{webSearchLabel}</span>
              <Icon name="chevron-down" size={12} />
              <select
                aria-describedby="web-search-description"
                aria-label="会话联网搜索模式"
                disabled={!webSearchAvailable || disabled}
                value={webSearchAvailable ? webSearchMode : 'off'}
                onChange={(event) => onWebSearchModeChange(event.target.value as WebSearchMode)}
              >
                <option value="off">关闭</option>
                <option value="auto">自动搜索</option>
                <option value="native">原生优先（不支持时回退）</option>
              </select>
            </label>
          </div>

          <div className="composer-tools-right">
            <button className={`context-meter is-${contextTone}`} onClick={onOpenModelSettings} title="可用输入预算（已预留模型输出空间）">
              <span className="context-ring" style={{ '--context': `${contextPercentage * 3.6}deg` } as CSSProperties} />
              <span>{compactNumber(contextTokens)} / {compactNumber(contextLimit)}</span>
              <em>{contextMode === 'manual' ? '手动' : '自动'}</em>
            </button>
            {streaming ? (
              <button className="send-button stop-button" aria-label="停止生成" onClick={onStop}><span /></button>
            ) : (
              <button
                className="send-button"
                aria-label="发送消息"
                disabled={disabled || sendBlocked || !draft.trim()}
                onClick={onSend}
              >
                <Icon name="arrow-up" size={19} />
              </button>
            )}
          </div>
        </div>
      </div>
      <p className="composer-hint" id="web-search-description">
        AI 可能会出错，请核查重要信息。{sendOnEnter ? 'Enter 发送，Shift + Enter 换行' : '⌘ + Enter 发送'}
        {webSearchMode !== 'off' && webSearchAvailable && <span> · {webSearchDescription}</span>}
      </p>
    </div>
  )
}
