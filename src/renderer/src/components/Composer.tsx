import { useEffect, useRef, useState } from 'react'
import type { ClipboardEvent, CSSProperties, DragEvent, JSX } from 'react'
import type { McpServerConfig, MessageAttachment, Skill } from '../../../shared/types'
import type { ModelConfig, WebSearchMode } from '../types'
import { formatFileSize, processSelectedFiles } from '../file-helper'
import { handleComposerKeyDown } from '../composer-helper'
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
  skills?: Skill[]
  selectedSkillIds?: string[]
  mcpToolsCount?: number
  mcpServers?: McpServerConfig[]
  selectedMcpServerIds?: string[]
  reasoningEnabled: boolean
  webSearchAvailable: boolean
  webSearchMode: WebSearchMode
  sendBlocked: boolean
  sendOnEnter: boolean
  onAttachmentsChange: (attachments: MessageAttachment[]) => void
  onDraftChange: (draft: string) => void
  onOpenContextSettings: () => void
  onOpenModelSettings: () => void
  onOpenMcpSettings?: () => void
  onOpenSkillsSettings?: () => void
  onMcpServerSelectionChange?: (serverIds: string[]) => void
  onSkillSelectionChange?: (skillIds: string[]) => void
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
  skills = [],
  selectedSkillIds,
  mcpToolsCount,
  mcpServers = [],
  selectedMcpServerIds,
  reasoningEnabled,
  webSearchAvailable,
  webSearchMode,
  sendBlocked,
  sendOnEnter,
  onAttachmentsChange,
  onDraftChange,
  onOpenContextSettings,
  onOpenModelSettings,
  onOpenMcpSettings,
  onOpenSkillsSettings,
  onMcpServerSelectionChange,
  onSkillSelectionChange,
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
  const enabledMcpServers = mcpServers.filter((server) => server.enabled)
  const effectiveMcpServerIds = selectedMcpServerIds ?? enabledMcpServers.map((server) => server.id)
  const enabledSkills = skills.filter((skill) => skill.enabled)
  const fixedSkillIds = selectedSkillIds ?? []

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
            const action = handleComposerKeyDown({
              key: event.key,
              shiftKey: event.shiftKey,
              ctrlKey: event.ctrlKey,
              metaKey: event.metaKey,
              altKey: event.altKey,
              isComposing: event.nativeEvent.isComposing,
              sendOnEnter,
              canSend,
              draft,
              selectionStart: event.currentTarget.selectionStart ?? draft.length,
              selectionEnd: event.currentTarget.selectionEnd ?? draft.length
            })

            if (action.type === 'send') {
              event.preventDefault()
              onSend()
            } else if (action.type === 'newline') {
              event.preventDefault()
              if (action.nextDraft !== undefined) {
                onDraftChange(action.nextDraft)
              }
              if (action.nextCursor !== undefined) {
                requestAnimationFrame(() => {
                  if (textareaRef.current) {
                    textareaRef.current.selectionStart = textareaRef.current.selectionEnd = action.nextCursor!
                  }
                })
              }
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
              title={agentMode ? 'Agent 模式已开启（执行时支持 Skills 与 MCP 工具调用）' : '点击开启 Agent 智能体模式'}
            >
              <Icon name="bot" size={15} />
              <span>Agent</span>
              {agentMode && <Icon name="check" size={13} />}
            </button>
            {agentMode && enabledSkills.length > 0 && (
              <details className="mcp-conversation-selector skill-conversation-selector">
                <summary
                  className={`mcp-indicator-pill skill-indicator-pill ${fixedSkillIds.length > 0 ? 'is-active' : ''}`}
                  title="固定本会话技能；不选择时由 Agent 自动路由"
                >
                  <Icon name="sparkles" size={14} />
                  <span>Skills · {fixedSkillIds.length > 0 ? `${fixedSkillIds.length}/${enabledSkills.length}` : '自动'}</span>
                  <Icon name="chevron-down" size={12} />
                </summary>
                <div className="mcp-conversation-menu skill-conversation-menu">
                  <strong>本会话技能路由</strong>
                  <button
                    className={fixedSkillIds.length === 0 ? 'is-selected' : ''}
                    type="button"
                    onClick={() => onSkillSelectionChange?.([])}
                  >
                    自动选择相关技能
                  </button>
                  <div className="mcp-conversation-options">
                    {enabledSkills.map((skill) => (
                      <label key={skill.id} title={skill.description}>
                        <input
                          type="checkbox"
                          checked={fixedSkillIds.includes(skill.id)}
                          onChange={(event) => {
                            const next = event.target.checked
                              ? [...new Set([...fixedSkillIds, skill.id])]
                              : fixedSkillIds.filter((id) => id !== skill.id)
                            onSkillSelectionChange?.(next)
                          }}
                        />
                        <span>{skill.name}</span>
                      </label>
                    ))}
                  </div>
                  <small>固定技能会在每轮预加载；自动模式按请求匹配，模型也可按需加载目录中的其他技能。</small>
                  <button type="button" onClick={onOpenSkillsSettings}>管理 Skills</button>
                </div>
              </details>
            )}
            {agentMode && enabledMcpServers.length > 0 && (
              <details className="mcp-conversation-selector">
                <summary className="mcp-indicator-pill" title="选择本会话允许使用的 MCP 服务">
                  <Icon name="tool" size={14} />
                  <span>MCP · {effectiveMcpServerIds.length}/{enabledMcpServers.length}</span>
                  <Icon name="chevron-down" size={12} />
                </summary>
                <div className="mcp-conversation-menu">
                  <strong>本会话允许的 MCP 服务</strong>
                  {enabledMcpServers.map((server) => (
                    <label key={server.id}>
                      <input
                        type="checkbox"
                        checked={effectiveMcpServerIds.includes(server.id)}
                        onChange={(event) => {
                          const next = event.target.checked
                            ? [...new Set([...effectiveMcpServerIds, server.id])]
                            : effectiveMcpServerIds.filter((id) => id !== server.id)
                          onMcpServerSelectionChange?.(next)
                        }}
                      />
                      <span>{server.name}</span>
                    </label>
                  ))}
                  <small>{mcpToolsCount ?? 0} 个工具已发现；未选中的服务不会暴露给模型。</small>
                  <button type="button" onClick={onOpenMcpSettings}>管理 MCP 服务</button>
                </div>
              </details>
            )}
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
        AI 可能会出错，请核查重要信息。{sendOnEnter ? 'Enter 发送，Shift / Ctrl / ⌘ + Enter 换行' : '⌘ / Ctrl + Enter 发送，Enter 换行'}
        {webSearchMode !== 'off' && webSearchAvailable && <span> · {webSearchDescription}</span>}
      </p>
    </div>
  )
}
