import { useEffect, useRef, useState } from 'react'
import type { ClipboardEvent, CSSProperties, DragEvent, JSX } from 'react'
import type { MessageAttachment } from '../../../shared/types'
import type { ModelConfig, WebSearchMode } from '../types'
import { formatFileSize, processSelectedFiles } from '../file-helper'
import { WEB_SEARCH_MODE_LABELS } from '../web-search'
import { Icon } from './Icon'

interface ComposerProps {
  activeModel?: ModelConfig
  attachments: MessageAttachment[]
  contextCanTrimOnce: boolean
  contextLimit: number
  contextMessage: string
  contextMode: 'manual' | 'auto'
  contextTone: 'ok' | 'warning' | 'error'
  contextTokens: number
  disabled?: boolean
  draft: string
  agentMode?: boolean
  reasoningEnabled: boolean
  webSearchAvailable: boolean
  webSearchMode: WebSearchMode
  sendBlocked: boolean
  sendOnEnter: boolean
  onAttachmentsChange: (attachments: MessageAttachment[]) => void
  onDraftChange: (draft: string) => void
  onOpenContextSettings: () => void
  onOpenModelSettings: () => void
  onSend: () => void
  onSendWithTrim: () => void
  onStop: () => void
  onToggleAgentMode?: () => void
  onToggleReasoning: () => void
  onWebSearchModeChange: (mode: WebSearchMode) => void
  onShowToast: (message: string) => void
  streaming: boolean
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 ? 1 : 0)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value % 1_000 ? 1 : 0)}k`
  return String(value)
}

export function Composer({
  activeModel,
  attachments,
  contextCanTrimOnce,
  contextLimit,
  contextMessage,
  contextMode,
  contextTone,
  contextTokens,
  disabled,
  draft,
  agentMode = false,
  reasoningEnabled,
  webSearchAvailable,
  webSearchMode,
  sendBlocked,
  sendOnEnter,
  onAttachmentsChange,
  onDraftChange,
  onOpenContextSettings,
  onOpenModelSettings,
  onSend,
  onSendWithTrim,
  onStop,
  onToggleAgentMode,
  onToggleReasoning,
  onWebSearchModeChange,
  onShowToast,
  streaming
}: ComposerProps): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [uploading, setUploading] = useState(false)

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

  const handleAddFiles = async (files: FileList | File[]): Promise<void> => {
    if (disabled || uploading) return
    setUploading(true)
    try {
      const processed = await processSelectedFiles(files)
      onAttachmentsChange([...attachments, ...processed])
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '文件读取失败')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleRemoveAttachment = (id: string): void => {
    onAttachmentsChange(attachments.filter((item) => item.id !== id))
  }

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const items = event.clipboardData?.items
    if (!items) return
    const fileItems: File[] = []
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      if (item && item.kind === 'file') {
        const file = item.getAsFile()
        if (file) fileItems.push(file)
      }
    }
    if (fileItems.length > 0) {
      event.preventDefault()
      void handleAddFiles(fileItems)
    }
  }

  const handleDragOver = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    if (!disabled && !isDragging) setIsDragging(true)
  }

  const handleDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    if (event.currentTarget.contains(event.relatedTarget as Node)) return
    setIsDragging(false)
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setIsDragging(false)
    if (disabled) return
    const files = event.dataTransfer?.files
    if (files && files.length > 0) {
      void handleAddFiles(files)
    }
  }

  const canSend = !disabled && !sendBlocked && (Boolean(draft.trim()) || attachments.length > 0)

  return (
    <div
      className={`composer-wrap ${isDragging ? 'is-drag-over' : ''}`}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
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
        <input
          ref={fileInputRef}
          accept="image/*,.pdf,.txt,.md,.json,.csv,.ts,.tsx,.js,.jsx,.py,.html,.css,.yaml,.yml,.xml,.sql,.sh,.log"
          aria-label="上传文件"
          hidden
          multiple
          type="file"
          onChange={(event) => {
            if (event.target.files?.length) void handleAddFiles(event.target.files)
          }}
        />

        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((attachment) => (
              <div key={attachment.id} className="composer-attachment-item">
                {attachment.type === 'image' ? (
                  <img alt={attachment.name} className="composer-attachment-preview" src={attachment.data} />
                ) : (
                  <div className="composer-attachment-file-icon">
                    <Icon name={attachment.type === 'document' ? 'file' : 'code'} size={16} />
                  </div>
                )}
                <div className="composer-attachment-info">
                  <span className="composer-attachment-name" title={attachment.name}>{attachment.name}</span>
                  <small className="composer-attachment-size">{formatFileSize(attachment.size)}</small>
                </div>
                <button
                  aria-label="移除附件"
                  className="composer-attachment-remove"
                  onClick={() => handleRemoveAttachment(attachment.id)}
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
            ))}
          </div>
        )}

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
              if (canSend) onSend()
            }
          }}
          onPaste={handlePaste}
          placeholder={disabled ? '请先配置可用模型与 API 密钥' : '给 AgentBox 发送消息（支持拖拽/粘贴文件或图片）…'}
          rows={1}
          value={draft}
        />

        <div className="composer-toolbar">
          <div className="composer-tools-left">
            <button
              aria-label="添加图片或文件"
              className="composer-action-button"
              disabled={disabled || uploading}
              onClick={() => fileInputRef.current?.click()}
              title="上传图片或文本文件（支持粘贴与拖拽）"
            >
              <Icon name="paperclip" size={15} />
              {uploading && <span className="upload-spinner" />}
            </button>
            <button
              className={`agent-pill ${agentMode ? 'is-active' : ''}`}
              disabled={disabled}
              onClick={onToggleAgentMode}
              title={agentMode ? 'Agent 模式已开启（执行时注入已激活 Skills）' : '点击开启 Agent 智能体模式'}
            >
              <Icon name="bot" size={15} />
              <span>Agent</span>
              {agentMode && <Icon name="check" size={13} />}
            </button>
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
                disabled={!canSend}
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

