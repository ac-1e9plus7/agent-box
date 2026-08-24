import { useEffect, useRef, useState } from 'react'
import type { ClipboardEvent, CSSProperties, DragEvent, JSX } from 'react'
import type { McpServerConfig, MessageAttachment, Skill } from '../../../shared/types'
import type { ModelConfig, WebSearchMode } from '../types'
import { formatFileSize, processSelectedFiles } from '../file-helper'
import { handleComposerKeyDown } from '../composer-helper'
import { WEB_SEARCH_MODE_LABELS } from '../web-search'
import { Icon } from './Icon'
import { t } from "../../../shared/i18n"

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
    ? t("Reasoning unavailable")
    : reasoningEnabled
      ? t("Reasoning · {value0}", { value0: activeModel.defaultReasoningEffort.toUpperCase() })
      : t("Reasoning off")
  const webSearchLabel = !webSearchAvailable
    ? t("Web search unavailable")
    : webSearchMode === 'off'
      ? t("Web search off")
      : WEB_SEARCH_MODE_LABELS[webSearchMode]
  const webSearchDescription = webSearchAvailable
    ? t("Web search may incur additional charges and sends queries to a search provider. “Prefer native web search” falls back automatically when native search is unavailable.")
    : t("Web search is currently available only with OpenRouter connections.")
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
      onShowToast(error instanceof Error ? error.message : t("Could not read the file"))
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
            <button onClick={onSendWithTrim}>{t("Trim context and send")}</button>
          ) : contextTone === 'error' ? (
            <button onClick={onOpenContextSettings}>{t("Context settings")}</button>
          ) : null}
        </div>
      )}
      <div className={`composer ${disabled ? 'is-disabled' : ''} ${contextTone === 'error' ? 'has-context-error' : ''}`}>
        <input
          ref={fileInputRef}
          accept="image/*,.pdf,.txt,.md,.json,.csv,.ts,.tsx,.js,.jsx,.py,.html,.css,.yaml,.yml,.xml,.sql,.sh,.log"
          aria-label={t("Upload files")}
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
                  aria-label={t("Remove attachment")}
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
          aria-label={t("Message input box")}
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
          placeholder={disabled ? t("Please configure available models and API keys first") : t("Send a message to AgentBox (supports dragging/pasting files or images)…")}
          rows={1}
          value={draft}
        />

        <div className="composer-toolbar">
          <div className="composer-tools-left">
            <button
              aria-label={t("Add a picture or file")}
              className="composer-action-button"
              disabled={disabled || uploading}
              onClick={() => fileInputRef.current?.click()}
              title={t("Upload images or text files (paste or drag and drop supported)")}
            >
              <Icon name="paperclip" size={15} />
              {uploading && <span className="upload-spinner" />}
            </button>
            <button
              className={`agent-pill ${agentMode ? 'is-active' : ''}`}
              disabled={disabled}
              onClick={onToggleAgentMode}
              title={agentMode ? t("Agent mode is on (Skills and MCP tool calls are available during execution)") : t("Click to enable Agent mode")}
            >
              <Icon name="bot" size={15} />
              <span>Agent</span>
              {agentMode && <Icon name="check" size={13} />}
            </button>
            {agentMode && enabledSkills.length > 0 && (
              <details className="mcp-conversation-selector skill-conversation-selector">
                <summary
                  className={`mcp-indicator-pill skill-indicator-pill ${fixedSkillIds.length > 0 ? 'is-active' : ''}`}
                  title={t("Pin skills for this conversation; when none are selected, the Agent routes automatically")}
                >
                  <Icon name="sparkles" size={14} />
                  <span>{t("Skills · {selection}", { selection: fixedSkillIds.length > 0 ? `${fixedSkillIds.length}/${enabledSkills.length}` : t("Auto") })}</span>
                  <Icon name="chevron-down" size={12} />
                </summary>
                <div className="mcp-conversation-menu skill-conversation-menu">
                  <strong>{t("Skill routing for this conversation")}</strong>
                  <button
                    className={fixedSkillIds.length === 0 ? 'is-selected' : ''}
                    type="button"
                    onClick={() => onSkillSelectionChange?.([])}
                  >{t("Automatically select relevant skills")}</button>
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
                  <small>{t("Fixed skills are preloaded each round; automatic mode matches on request, and the model can also load other skills from the catalog on demand.")}</small>
                  <button type="button" onClick={onOpenSkillsSettings}>{t("Manage Skills")}</button>
                </div>
              </details>
            )}
            {agentMode && enabledMcpServers.length > 0 && (
              <details className="mcp-conversation-selector">
                <summary className="mcp-indicator-pill" title={t("Select the MCP servers available to this conversation")}>
                  <Icon name="tool" size={14} />
                  <span>MCP · {effectiveMcpServerIds.length}/{enabledMcpServers.length}</span>
                  <Icon name="chevron-down" size={12} />
                </summary>
                <div className="mcp-conversation-menu">
                  <strong>{t("MCP servers available to this conversation")}</strong>
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
                  <small>{t("{value0} tools found; unselected servers will not be exposed to the model.", { value0: mcpToolsCount ?? 0 })}</small>
                  <button type="button" onClick={onOpenMcpSettings}>{t("Manage MCP servers")}</button>
                </div>
              </details>
            )}
            <button
              className={`reasoning-pill ${reasoningEnabled ? 'is-active' : ''}`}
              disabled={!activeModel?.supportsReasoning || disabled}
              onClick={onToggleReasoning}
              title={activeModel?.supportsReasoning ? t("Toggle reasoning") : t("The current model does not support reasoning")}
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
                aria-label={t("Conversation web search mode")}
                disabled={!webSearchAvailable || disabled}
                value={webSearchAvailable ? webSearchMode : 'off'}
                onChange={(event) => onWebSearchModeChange(event.target.value as WebSearchMode)}
              >
                <option value="off">{t("Off")}</option>
                <option value="auto">{t("Automatic web search")}</option>
                <option value="native">{t("Prefer native web search (fallback when unavailable)")}</option>
              </select>
            </label>
          </div>

          <div className="composer-tools-right">
            <button className={`context-meter is-${contextTone}`} onClick={onOpenModelSettings} title={t("Available input budget (after reserving space for model output)")}>
              <span className="context-ring" style={{ '--context': `${contextPercentage * 3.6}deg` } as CSSProperties} />
              <span>{compactNumber(contextTokens)} / {compactNumber(contextLimit)}</span>
              <em>{contextMode === 'manual' ? t("Manual") : t("Auto")}</em>
            </button>
            {streaming ? (
              <button className="send-button stop-button" aria-label={t("Stop generating")} onClick={onStop}><span /></button>
            ) : (
              <button
                className="send-button"
                aria-label={t("Send message")}
                disabled={!canSend}
                onClick={onSend}
              >
                <Icon name="arrow-up" size={19} />
              </button>
            )}
          </div>
        </div>
      </div>
      <p className="composer-hint" id="web-search-description">{t("AI can make mistakes. Check important information.")}{sendOnEnter ? t("Enter to send; Shift / Ctrl / ⌘ + Enter for a new line") : t("⌘ / Ctrl + Enter to send; Enter for a new line")}
        {webSearchMode !== 'off' && webSearchAvailable && <span> · {webSearchDescription}</span>}
      </p>
    </div>
  )
}
