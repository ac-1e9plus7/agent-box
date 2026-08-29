import { useEffect, useMemo, useState } from 'react'
import type { Dispatch, JSX, SetStateAction } from 'react'
import type {
  McpServerConfig,
  McpServerInput,
  McpServerTestResult,
  McpToolDefinition,
  Skill,
} from '../../../../shared/types'
import type { AppPreferences } from '../../types'
import { createBuiltinAgentToolCatalog } from '../../../../shared/builtin-agent-tools'
import { t } from '../../../../shared/i18n'
import { Icon } from '../Icon'
import { SettingsToggle } from './SettingsControls'

const BUILTIN_TOOL_FILTER = '__agentbox_builtin__'

interface ExploredToolDefinition extends McpToolDefinition {
  source: 'builtin' | 'mcp'
}

interface McpTabProps {
  mcpServers: McpServerConfig[]
  onListMcpTools?: (serverId?: string) => Promise<McpToolDefinition[]>
  onRemoveMcpServer?: (id: string) => Promise<void>
  onTestMcpServer?: (input: McpServerInput) => Promise<McpServerTestResult>
  onToggleMcpServer?: (id: string, enabled: boolean) => Promise<McpServerConfig>
  onUpsertMcpServer?: (input: McpServerInput) => Promise<McpServerConfig>
  preferenceDraft: AppPreferences
  setPreferenceDraft: Dispatch<SetStateAction<AppPreferences>>
  skills: Skill[]
}

export function McpTab({
  mcpServers,
  onListMcpTools,
  onRemoveMcpServer,
  onTestMcpServer,
  onToggleMcpServer,
  onUpsertMcpServer,
  preferenceDraft,
  setPreferenceDraft,
  skills,
}: McpTabProps): JSX.Element {
  const skillsList = skills
  const [mcpServersList, setMcpServersList] = useState<McpServerConfig[]>(mcpServers)
  const [editingMcpServer, setEditingMcpServer] = useState<McpServerInput | null>(null)
  const [mcpSearch, setMcpSearch] = useState('')
  const [mcpActionError, setMcpActionError] = useState('')
  const [testingServerId, setTestingServerId] = useState<string | null>(null)
  const [serverTestResults, setServerTestResults] = useState<Record<string, McpServerTestResult>>({})
  const [toolExplorerOpen, setToolExplorerOpen] = useState(false)
  const [toolExplorerSearch, setToolExplorerSearch] = useState('')
  const [toolExplorerServerFilter, setToolExplorerServerFilter] = useState<string>('all')
  const [exploredTools, setExploredTools] = useState<McpToolDefinition[]>([])
  const [loadingTools, setLoadingTools] = useState(false)
  const [editingMcpEnvRows, setEditingMcpEnvRows] = useState<Array<{ key: string; value: string }>>([])
  const [editingMcpHeadersRows, setEditingMcpHeadersRows] = useState<Array<{ key: string; value: string }>>([])
  const [editingMcpArgsText, setEditingMcpArgsText] = useState('')
  const [modalTestResult, setModalTestResult] = useState<McpServerTestResult | null>(null)
  const [modalTesting, setModalTesting] = useState(false)

  useEffect(() => {
    setMcpServersList(mcpServers)
  }, [mcpServers])

  const handleToggleMcpServer = async (id: string, enabled: boolean) => {
    try {
      if (onToggleMcpServer) {
        const updated = await onToggleMcpServer(id, enabled)
        setMcpServersList((curr) => curr.map((s) => (s.id === id ? updated : s)))
      }
    } catch (err) {
      setMcpActionError(err instanceof Error ? err.message : t('Operation failed'))
    }
  }

  const handleRemoveMcpServer = async (id: string) => {
    try {
      if (onRemoveMcpServer) {
        await onRemoveMcpServer(id)
        setMcpServersList((curr) => curr.filter((s) => s.id !== id))
      }
    } catch (err) {
      setMcpActionError(err instanceof Error ? err.message : t('Delete failed'))
    }
  }

  const startEditMcpServer = (server?: McpServerConfig) => {
    if (server) {
      setEditingMcpServer({
        id: server.id,
        name: server.name,
        description: server.description || '',
        transport: server.transport,
        command: server.command || '',
        args: server.args || [],
        env: server.env || {},
        url: server.url || '',
        headers: server.headers || {},
        enabled: server.enabled,
      })
      setEditingMcpArgsText((server.args || []).join('\n'))
      setEditingMcpEnvRows(Object.entries(server.env || {}).map(([key, value]) => ({ key, value })))
      setEditingMcpHeadersRows(Object.entries(server.headers || {}).map(([key, value]) => ({ key, value })))
    } else {
      setEditingMcpServer({
        name: '',
        description: '',
        transport: 'stdio',
        command: 'npx',
        args: [],
        env: {},
        url: 'http://localhost:3000/sse',
        headers: {},
        enabled: true,
      })
      setEditingMcpArgsText('')
      setEditingMcpEnvRows([])
      setEditingMcpHeadersRows([])
    }
    setModalTestResult(null)
  }

  const handleSaveMcpModal = async () => {
    if (!editingMcpServer) return
    const envObj: Record<string, string> = {}
    for (const row of editingMcpEnvRows) {
      if (row.key.trim()) envObj[row.key.trim()] = row.value
    }
    const headersObj: Record<string, string> = {}
    for (const row of editingMcpHeadersRows) {
      if (row.key.trim()) headersObj[row.key.trim()] = row.value
    }
    const argsArr = editingMcpArgsText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)

    const payload: McpServerInput = {
      ...editingMcpServer,
      args: argsArr,
      env: envObj,
      headers: headersObj,
    }

    try {
      if (onUpsertMcpServer) {
        const saved = await onUpsertMcpServer(payload)
        setMcpServersList((curr) => {
          const idx = curr.findIndex((s) => s.id === saved.id)
          if (idx >= 0) {
            const next = [...curr]
            next[idx] = saved
            return next
          }
          return [...curr, saved]
        })
        setEditingMcpServer(null)
      }
    } catch (err) {
      setMcpActionError(err instanceof Error ? err.message : t('Save failed'))
    }
  }

  const handleTestMcpModal = async () => {
    if (!editingMcpServer || !onTestMcpServer) return
    const envObj: Record<string, string> = {}
    for (const row of editingMcpEnvRows) {
      if (row.key.trim()) envObj[row.key.trim()] = row.value
    }
    const headersObj: Record<string, string> = {}
    for (const row of editingMcpHeadersRows) {
      if (row.key.trim()) headersObj[row.key.trim()] = row.value
    }
    const argsArr = editingMcpArgsText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)

    const payload: McpServerInput = {
      ...editingMcpServer,
      args: argsArr,
      env: envObj,
      headers: headersObj,
    }

    setModalTesting(true)
    try {
      const res = await onTestMcpServer(payload)
      setModalTestResult(res)
    } catch (err) {
      setModalTestResult({
        ok: false,
        latencyMs: 0,
        toolsCount: 0,
        message: err instanceof Error ? err.message : t('Connection error'),
      })
    } finally {
      setModalTesting(false)
    }
  }

  const handleTestServerInList = async (server: McpServerConfig) => {
    if (!onTestMcpServer) return
    setTestingServerId(server.id)
    try {
      const res = await onTestMcpServer({
        id: server.id,
        name: server.name,
        transport: server.transport,
        command: server.command,
        args: server.args,
        env: server.env,
        url: server.url,
        headers: server.headers,
      })
      setServerTestResults((curr) => ({ ...curr, [server.id]: res }))
    } catch (err) {
      setServerTestResults((curr) => ({
        ...curr,
        [server.id]: {
          ok: false,
          latencyMs: 0,
          toolsCount: 0,
          message: err instanceof Error ? err.message : t('Connection test failed'),
        },
      }))
    } finally {
      setTestingServerId(null)
    }
  }

  const openToolExplorerModal = async () => {
    setToolExplorerOpen(true)
    setLoadingTools(true)
    try {
      if (onListMcpTools) {
        const tools = await onListMcpTools()
        setExploredTools(tools)
      }
    } catch (err) {
      console.warn('Failed to list MCP tools:', err)
    } finally {
      setLoadingTools(false)
    }
  }

  const filteredMcpServers = useMemo(() => {
    const q = mcpSearch.trim().toLowerCase()
    if (!q) return mcpServersList
    return mcpServersList.filter(
      (s) => s.name.toLowerCase().includes(q) || (s.description && s.description.toLowerCase().includes(q)),
    )
  }, [mcpServersList, mcpSearch])

  const builtinExploredTools = useMemo<ExploredToolDefinition[]>(
    () =>
      createBuiltinAgentToolCatalog(skillsList, {
        browserEnabled: preferenceDraft.builtInBrowserEnabled,
        browserScreenshotsEnabled: preferenceDraft.browserAgentScreenshotsEnabled,
        browserUploadsEnabled: preferenceDraft.browserFileUploadsEnabled,
        browserDownloadsEnabled: preferenceDraft.browserDownloadsEnabled,
      }).map((tool) => ({ ...tool, source: 'builtin' })),
    [
      preferenceDraft.browserAgentScreenshotsEnabled,
      preferenceDraft.browserDownloadsEnabled,
      preferenceDraft.browserFileUploadsEnabled,
      preferenceDraft.builtInBrowserEnabled,
      skillsList,
    ],
  )

  const allExploredTools = useMemo<ExploredToolDefinition[]>(
    () => [...builtinExploredTools, ...exploredTools.map((tool) => ({ ...tool, source: 'mcp' as const }))],
    [builtinExploredTools, exploredTools],
  )

  const filteredExploredTools = useMemo(() => {
    return allExploredTools.filter((tool) => {
      if (toolExplorerServerFilter === BUILTIN_TOOL_FILTER && tool.source !== 'builtin') {
        return false
      }
      if (
        toolExplorerServerFilter !== 'all' &&
        toolExplorerServerFilter !== BUILTIN_TOOL_FILTER &&
        (tool.source !== 'mcp' || tool.serverId !== toolExplorerServerFilter)
      ) {
        return false
      }
      const q = toolExplorerSearch.trim().toLowerCase()
      if (!q) return true
      return (
        tool.name.toLowerCase().includes(q) ||
        (tool.modelName && tool.modelName.toLowerCase().includes(q)) ||
        (tool.description && tool.description.toLowerCase().includes(q)) ||
        tool.serverName.toLowerCase().includes(q) ||
        (tool.source === 'builtin' && t('Built-in').includes(q))
      )
    })
  }, [allExploredTools, toolExplorerServerFilter, toolExplorerSearch])

  return (
    <div className="settings-section-content mcp-settings">
      <section className="settings-card mcp-global-card">
        <h3>{t('Global MCP settings')}</h3>
        <div className="settings-row">
          <div>
            <strong>{t('Enable MCP integration')}</strong>
            <small>{t('When enabled, Agent mode can discover and call tools from connected MCP servers')}</small>
          </div>
          <SettingsToggle
            checked={preferenceDraft.mcpEnabled ?? true}
            label={(preferenceDraft.mcpEnabled ?? true) ? t('Enabled') : t('Deactivated')}
            onChange={(enabled) => setPreferenceDraft((curr) => ({ ...curr, mcpEnabled: enabled }))}
          />
        </div>
        <div className="settings-row">
          <div>
            <strong>{t('Tool retrieval mode')}</strong>
            <small>
              {t(
                'Automatic tool retrieval (auto) selects the most relevant tools dynamically; Load all tools (all) exposes every available tool.',
              )}
            </small>
          </div>
          <div className="segmented-control">
            <button
              className={(preferenceDraft.mcpToolRetrievalMode ?? 'auto') === 'auto' ? 'is-active' : ''}
              onClick={() => setPreferenceDraft((curr) => ({ ...curr, mcpToolRetrievalMode: 'auto' }))}
            >
              {t('Automatic tool retrieval (auto)')}
            </button>
            <button
              className={preferenceDraft.mcpToolRetrievalMode === 'all' ? 'is-active' : ''}
              onClick={() => setPreferenceDraft((curr) => ({ ...curr, mcpToolRetrievalMode: 'all' }))}
            >
              {t('Load all tools (all)')}
            </button>
          </div>
        </div>
        <div className="settings-row">
          <div>
            <strong>{t('Tool approval policy')}</strong>
            <small>
              {t(
                'Full Access skips all approval prompts for code, terminal, workspace, MCP, and built-in browser operations.',
              )}
            </small>
          </div>
          <div className="segmented-control">
            <button
              className={preferenceDraft.mcpToolApprovalPolicy === 'always' ? 'is-active' : ''}
              onClick={() => setPreferenceDraft((curr) => ({ ...curr, mcpToolApprovalPolicy: 'always' }))}
            >
              {t('Always ask')}
            </button>
            <button
              className={(preferenceDraft.mcpToolApprovalPolicy ?? 'sensitive') === 'sensitive' ? 'is-active' : ''}
              onClick={() => setPreferenceDraft((curr) => ({ ...curr, mcpToolApprovalPolicy: 'sensitive' }))}
            >
              {t('Smart approval')}
            </button>
            <button
              className={preferenceDraft.mcpToolApprovalPolicy === 'full-access' ? 'is-active' : ''}
              onClick={() => setPreferenceDraft((curr) => ({ ...curr, mcpToolApprovalPolicy: 'full-access' }))}
            >
              {t('Full Access')}
            </button>
          </div>
        </div>
        {preferenceDraft.mcpToolApprovalPolicy === 'full-access' && (
          <div className="full-access-warning" role="alert">
            <Icon name="shield" size={15} />
            <span>
              <strong>{t('Full Access is enabled')}</strong>
              <small>
                {t(
                  'The model can run terminal commands and code, use MCP tools with side effects, and operate browser pages including uploads and downloads. Use this only when you trust the model, connected MCP servers, visited websites, and task.',
                )}
              </small>
            </span>
          </div>
        )}
        <div className="settings-row">
          <div>
            <strong>{t('Approval timeout')}</strong>
            <small>
              {t(
                'Even with no timeout, you can end the wait by denying the request, stopping generation, closing the conversation, or quitting the app.',
              )}
            </small>
          </div>
          <div className="segmented-control">
            <button
              className={
                (preferenceDraft.toolApprovalTimeoutMode ?? 'five-minutes') === 'five-minutes' ? 'is-active' : ''
              }
              onClick={() => setPreferenceDraft((curr) => ({ ...curr, toolApprovalTimeoutMode: 'five-minutes' }))}
            >
              {t('5 minutes')}
            </button>
            <button
              className={preferenceDraft.toolApprovalTimeoutMode === 'never' ? 'is-active' : ''}
              onClick={() => setPreferenceDraft((curr) => ({ ...curr, toolApprovalTimeoutMode: 'never' }))}
            >
              {t('No timeout')}
            </button>
          </div>
        </div>
      </section>

      <div className="mcp-toolbar">
        <div className="mcp-toolbar-left">
          <div className="mcp-search-box">
            <Icon name="search" size={15} />
            <input
              placeholder={t('Search MCP server names or descriptions…')}
              value={mcpSearch}
              onChange={(e) => setMcpSearch(e.target.value)}
            />
            {mcpSearch && (
              <button className="icon-button" onClick={() => setMcpSearch('')} aria-label={t('Clear search')}>
                <Icon name="close" size={13} />
              </button>
            )}
          </div>
        </div>
        <div className="mcp-toolbar-right">
          <button className="mcp-action-btn" onClick={() => void openToolExplorerModal()}>
            <Icon name="tool" size={14} />
            <span>{t('Tool Explorer')}</span>
          </button>
          <button className="mcp-action-btn is-primary" onClick={() => startEditMcpServer()}>
            <Icon name="plus" size={14} />
            <span>{t('Add MCP server')}</span>
          </button>
        </div>
      </div>

      {mcpActionError && (
        <div className="settings-error-banner" role="alert">
          <Icon name="info" size={15} />
          <span>{mcpActionError}</span>
          <button className="icon-button" onClick={() => setMcpActionError('')}>
            <Icon name="close" size={13} />
          </button>
        </div>
      )}

      <div className="mcp-servers-grid">
        {filteredMcpServers.length === 0 ? (
          <div className="mcp-empty">
            <Icon name="tool" size={32} />
            <p>{t('No MCP servers configured')}</p>
            <small>
              {t(
                'Select “Add MCP server” above to connect a local command-line process or a remote Streamable HTTP server.',
              )}
            </small>
          </div>
        ) : (
          filteredMcpServers.map((server) => {
            const testResult = serverTestResults[server.id]
            const isTesting = testingServerId === server.id

            return (
              <div key={server.id} className={`mcp-server-card ${!server.enabled ? 'is-disabled' : ''}`}>
                <div className="mcp-card-header">
                  <div className="mcp-server-icon">
                    <Icon name={server.transport === 'stdio' ? 'code' : 'globe'} size={18} />
                  </div>
                  <div className="mcp-server-meta">
                    <div className="mcp-server-name-row">
                      <h4>{server.name}</h4>
                      <span className={`mcp-transport-badge ${server.transport}`}>
                        {server.transport.toUpperCase()}
                      </span>
                    </div>
                    {server.description && <p className="mcp-server-desc">{server.description}</p>}
                  </div>
                  <div className="mcp-toggle-wrapper">
                    <SettingsToggle
                      checked={server.enabled}
                      label={server.enabled ? t('Enabled') : t('Deactivated')}
                      onChange={(enabled) => void handleToggleMcpServer(server.id, enabled)}
                    />
                  </div>
                </div>

                <div className="mcp-server-details">
                  {server.transport === 'stdio' ? (
                    <div className="mcp-detail-row">
                      <span className="mcp-detail-label">{t('Command:')}</span>
                      <code>
                        {server.command} {(server.args || []).join(' ')}
                      </code>
                    </div>
                  ) : (
                    <div className="mcp-detail-row">
                      <span className="mcp-detail-label">{t('Endpoint:')}</span>
                      <code>{server.url}</code>
                    </div>
                  )}
                </div>

                {testResult && (
                  <div className={`mcp-test-status ${testResult.ok ? 'is-ok' : 'is-err'}`}>
                    <Icon name={testResult.ok ? 'check' : 'info'} size={13} />
                    <span>
                      {testResult.message} ({testResult.latencyMs}ms)
                    </span>
                  </div>
                )}

                <div className="mcp-card-footer">
                  <button
                    className="mcp-footer-btn"
                    disabled={isTesting}
                    onClick={() => void handleTestServerInList(server)}
                  >
                    {isTesting ? <span className="button-spinner" /> : <Icon name="refresh" size={13} />}
                    <span>{isTesting ? t('Testing…') : t('Test connection')}</span>
                  </button>
                  <button className="mcp-footer-btn" onClick={() => startEditMcpServer(server)}>
                    <Icon name="edit" size={13} />
                    <span>{t('Edit')}</span>
                  </button>
                  <button className="mcp-footer-btn is-danger" onClick={() => void handleRemoveMcpServer(server.id)}>
                    <Icon name="trash" size={13} />
                    <span>{t('Delete')}</span>
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* MCP Server Add/Edit Modal */}
      {editingMcpServer && (
        <div className="skill-modal-backdrop" onClick={() => setEditingMcpServer(null)}>
          <div className="skill-modal mcp-edit-modal" onClick={(e) => e.stopPropagation()}>
            <header className="skill-modal-header">
              <h3>{editingMcpServer.id ? t('Edit MCP server') : t('mcp.addServerHeading')}</h3>
              <button className="icon-button" onClick={() => setEditingMcpServer(null)}>
                <Icon name="close" size={16} />
              </button>
            </header>
            <div className="skill-modal-body">
              <label className="skill-form-field">
                <span>{t('Server name (required)')}</span>
                <input
                  placeholder={t('For example: Filesystem server')}
                  value={editingMcpServer.name}
                  onChange={(e) => setEditingMcpServer({ ...editingMcpServer, name: e.target.value })}
                />
              </label>
              <label className="skill-form-field">
                <span>{t('Description (optional)')}</span>
                <input
                  placeholder={t('For example: Provide reading and writing capabilities for local workspace files')}
                  value={editingMcpServer.description || ''}
                  onChange={(e) => setEditingMcpServer({ ...editingMcpServer, description: e.target.value })}
                />
              </label>
              <div className="skill-form-field">
                <span>{t('Transport protocol type')}</span>
                <div className="segmented-control" style={{ width: '100%' }}>
                  <button
                    type="button"
                    className={editingMcpServer.transport === 'stdio' ? 'is-active' : ''}
                    onClick={() => setEditingMcpServer({ ...editingMcpServer, transport: 'stdio' })}
                  >
                    {t('Local command-line subprocess (stdio)')}
                  </button>
                  <button
                    type="button"
                    className={editingMcpServer.transport === 'http' ? 'is-active' : ''}
                    onClick={() => setEditingMcpServer({ ...editingMcpServer, transport: 'http' })}
                  >
                    {t('Remote HTTP (Streamable HTTP with legacy SSE fallback)')}
                  </button>
                  <button
                    type="button"
                    className={editingMcpServer.transport === 'sse' ? 'is-active' : ''}
                    onClick={() => setEditingMcpServer({ ...editingMcpServer, transport: 'sse' })}
                  >
                    {t('Legacy HTTP+SSE')}
                  </button>
                </div>
              </div>

              {editingMcpServer.transport === 'stdio' ? (
                <>
                  <label className="skill-form-field">
                    <span>{t('Execute command (Command)')}</span>
                    <input
                      placeholder={t('For example: npx, uvx, node, python')}
                      value={editingMcpServer.command || ''}
                      onChange={(e) => setEditingMcpServer({ ...editingMcpServer, command: e.target.value })}
                    />
                  </label>
                  <label className="skill-form-field">
                    <span>{t('Startup parameters (one parameter per line, separated by newlines)')}</span>
                    <textarea
                      className="mono-input"
                      placeholder={'-y\n@modelcontextprotocol/server-filesystem\nC:\\Projects'}
                      rows={4}
                      value={editingMcpArgsText}
                      onChange={(e) => setEditingMcpArgsText(e.target.value)}
                    />
                  </label>
                  <div className="skill-form-field">
                    <div className="mcp-keyvalue-head">
                      <span>{t('Environment Variables')}</span>
                      <button
                        type="button"
                        className="mcp-add-kv-btn"
                        onClick={() => setEditingMcpEnvRows([...editingMcpEnvRows, { key: '', value: '' }])}
                      >
                        <Icon name="plus" size={12} />
                        {t('Add variables')}
                      </button>
                    </div>
                    {editingMcpEnvRows.map((row, idx) => (
                      <div key={idx} className="mcp-kv-row">
                        <input
                          placeholder="KEY"
                          value={row.key}
                          onChange={(e) => {
                            const next = [...editingMcpEnvRows]
                            next[idx]!.key = e.target.value
                            setEditingMcpEnvRows(next)
                          }}
                        />
                        <input
                          placeholder="VALUE"
                          value={row.value}
                          onChange={(e) => {
                            const next = [...editingMcpEnvRows]
                            next[idx]!.value = e.target.value
                            setEditingMcpEnvRows(next)
                          }}
                        />
                        <button
                          type="button"
                          className="icon-button"
                          onClick={() => setEditingMcpEnvRows(editingMcpEnvRows.filter((_, i) => i !== idx))}
                        >
                          <Icon name="trash" size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <label className="skill-form-field">
                    <span>
                      {editingMcpServer.transport === 'sse'
                        ? t('Legacy HTTP+SSE endpoint URL')
                        : t('MCP HTTP endpoint URL')}
                    </span>
                    <input
                      placeholder={
                        editingMcpServer.transport === 'sse'
                          ? 'http://127.0.0.1:3000/sse'
                          : t('http://127.0.0.1:3000/mcp or https://.../mcp')
                      }
                      value={editingMcpServer.url || ''}
                      onChange={(e) => setEditingMcpServer({ ...editingMcpServer, url: e.target.value })}
                    />
                  </label>
                  <div className="skill-form-field">
                    <div className="mcp-keyvalue-head">
                      <span>{t('Custom request headers (HTTP Headers)')}</span>
                      <button
                        type="button"
                        className="mcp-add-kv-btn"
                        onClick={() => setEditingMcpHeadersRows([...editingMcpHeadersRows, { key: '', value: '' }])}
                      >
                        <Icon name="plus" size={12} />
                        {t('Add request header')}
                      </button>
                    </div>
                    {editingMcpHeadersRows.map((row, idx) => (
                      <div key={idx} className="mcp-kv-row">
                        <input
                          placeholder="Header-Name"
                          value={row.key}
                          onChange={(e) => {
                            const next = [...editingMcpHeadersRows]
                            next[idx]!.key = e.target.value
                            setEditingMcpHeadersRows(next)
                          }}
                        />
                        <input
                          placeholder="Header-Value"
                          value={row.value}
                          onChange={(e) => {
                            const next = [...editingMcpHeadersRows]
                            next[idx]!.value = e.target.value
                            setEditingMcpHeadersRows(next)
                          }}
                        />
                        <button
                          type="button"
                          className="icon-button"
                          onClick={() => setEditingMcpHeadersRows(editingMcpHeadersRows.filter((_, i) => i !== idx))}
                        >
                          <Icon name="trash" size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {modalTestResult && (
                <div
                  className={`mcp-test-status ${modalTestResult.ok ? 'is-ok' : 'is-err'}`}
                  style={{ marginTop: '12px' }}
                >
                  <Icon name={modalTestResult.ok ? 'check' : 'info'} size={14} />
                  <span>
                    {modalTestResult.message} ({modalTestResult.latencyMs}ms)
                  </span>
                </div>
              )}
            </div>
            <footer className="skill-modal-footer">
              <button
                type="button"
                className="secondary-button"
                disabled={modalTesting || !editingMcpServer.name.trim()}
                onClick={() => void handleTestMcpModal()}
              >
                {modalTesting ? (
                  <>
                    <span className="button-spinner" />
                    {t('Testing…')}
                  </>
                ) : (
                  <>
                    <Icon name="refresh" size={14} />
                    {t('Test connection')}
                  </>
                )}
              </button>
              <button className="secondary-button" onClick={() => setEditingMcpServer(null)}>
                {t('Cancel')}
              </button>
              <button
                className="primary-button"
                disabled={
                  !editingMcpServer.name.trim() ||
                  (editingMcpServer.transport === 'stdio'
                    ? !editingMcpServer.command?.trim()
                    : !editingMcpServer.url?.trim())
                }
                onClick={() => void handleSaveMcpModal()}
              >
                {t('Save server')}
              </button>
            </footer>
          </div>
        </div>
      )}

      {/* Tool Explorer Drawer / Modal */}
      {toolExplorerOpen && (
        <div className="skill-modal-backdrop" onClick={() => setToolExplorerOpen(false)}>
          <div className="skill-modal mcp-explorer-modal" onClick={(e) => e.stopPropagation()}>
            <header className="skill-modal-header">
              <div className="mcp-explorer-header-title">
                <Icon name="tool" size={18} />
                <h3>{t('Tool Explorer')}</h3>
                <span className="tool-count-pill">{t('{value0} tools', { value0: allExploredTools.length })}</span>
              </div>
              <button className="icon-button" onClick={() => setToolExplorerOpen(false)}>
                <Icon name="close" size={16} />
              </button>
            </header>
            <div className="skill-modal-body">
              <div className="mcp-explorer-toolbar">
                <div className="mcp-search-box">
                  <Icon name="search" size={14} />
                  <input
                    placeholder={t('Search tool name or description…')}
                    value={toolExplorerSearch}
                    onChange={(e) => setToolExplorerSearch(e.target.value)}
                  />
                </div>
                <select
                  className="mcp-server-filter-select"
                  value={toolExplorerServerFilter}
                  onChange={(e) => setToolExplorerServerFilter(e.target.value)}
                >
                  <option value="all">{t('All sources ({value0})', { value0: allExploredTools.length })}</option>
                  <option value={BUILTIN_TOOL_FILTER}>
                    {t('Built-in ({value0})', { value0: builtinExploredTools.length })}
                  </option>
                  {mcpServersList.length > 0 && (
                    <optgroup label={t('MCP servers')}>
                      {mcpServersList.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>

              {loadingTools ? (
                <div className="mcp-loading-tools">
                  <span className="button-spinner large" />
                  <p>{t('Loading the MCP tool list…')}</p>
                </div>
              ) : filteredExploredTools.length === 0 ? (
                <div className="mcp-empty">
                  <p>{t('No matching tool found')}</p>
                  <small>{t('Adjust the search or source filter and make sure the MCP server is enabled.')}</small>
                </div>
              ) : (
                <div className="mcp-tools-list">
                  {filteredExploredTools.map((tool) => (
                    <div
                      key={`${tool.source}-${tool.serverId}-${tool.name}`}
                      className={`mcp-tool-item-card ${tool.source === 'builtin' ? 'is-builtin' : ''}`}
                    >
                      <div className="mcp-tool-item-head">
                        <span className="mcp-tool-item-name">
                          {tool.source === 'builtin' ? tool.modelName || tool.name : tool.name}
                        </span>
                        <span className="mcp-tool-item-badges">
                          {tool.source === 'builtin' && (
                            <span className="mcp-tool-source-badge is-builtin">
                              <Icon name="sparkles" size={10} />
                              {t('Built-in')}
                            </span>
                          )}
                          <span className="mcp-tool-item-server">{tool.serverName}</span>
                        </span>
                      </div>
                      <p className="mcp-tool-item-desc">{tool.description || t('No description')}</p>
                      {tool.inputSchema?.properties && Object.keys(tool.inputSchema.properties).length > 0 && (
                        <details className="mcp-tool-schema-details">
                          <summary>
                            {t('Parameter definition ({value0})', {
                              value0: Object.keys(tool.inputSchema.properties).length,
                            })}
                          </summary>
                          <pre>
                            <code>{JSON.stringify(tool.inputSchema, null, 2)}</code>
                          </pre>
                        </details>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <footer className="skill-modal-footer">
              <button className="secondary-button" onClick={() => setToolExplorerOpen(false)}>
                {t('Close')}
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  )
}
