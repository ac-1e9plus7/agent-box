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
      setMcpActionError(err instanceof Error ? err.message : t("操作失败"))
    }
  }

  const handleRemoveMcpServer = async (id: string) => {
    try {
      if (onRemoveMcpServer) {
        await onRemoveMcpServer(id)
        setMcpServersList((curr) => curr.filter((s) => s.id !== id))
      }
    } catch (err) {
      setMcpActionError(err instanceof Error ? err.message : t("删除失败"))
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
      setEditingMcpEnvRows(
        Object.entries(server.env || {}).map(([key, value]) => ({ key, value }))
      )
      setEditingMcpHeadersRows(
        Object.entries(server.headers || {}).map(([key, value]) => ({ key, value }))
      )
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
      setMcpActionError(err instanceof Error ? err.message : t("保存失败"))
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
        message: err instanceof Error ? err.message : t("连接异常"),
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
        [server.id]: { ok: false, latencyMs: 0, toolsCount: 0, message: err instanceof Error ? err.message : t("测试异常") },
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
      (s) => s.name.toLowerCase().includes(q) || (s.description && s.description.toLowerCase().includes(q))
    )
  }, [mcpServersList, mcpSearch])

  const builtinExploredTools = useMemo<ExploredToolDefinition[]>(() => (
    createBuiltinAgentToolCatalog(skillsList).map((tool) => ({ ...tool, source: 'builtin' }))
  ), [skillsList])

  const allExploredTools = useMemo<ExploredToolDefinition[]>(() => [
    ...builtinExploredTools,
    ...exploredTools.map((tool) => ({ ...tool, source: 'mcp' as const })),
  ], [builtinExploredTools, exploredTools])

  const filteredExploredTools = useMemo(() => {
    return allExploredTools.filter((tool) => {
      if (toolExplorerServerFilter === BUILTIN_TOOL_FILTER && tool.source !== 'builtin') {
        return false
      }
      if (
        toolExplorerServerFilter !== 'all'
        && toolExplorerServerFilter !== BUILTIN_TOOL_FILTER
        && (tool.source !== 'mcp' || tool.serverId !== toolExplorerServerFilter)
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
        (tool.source === 'builtin' && t("系统内置").includes(q))
      )
    })
  }, [allExploredTools, toolExplorerServerFilter, toolExplorerSearch])



  return (
              <div className="settings-section-content mcp-settings">
                <section className="settings-card mcp-global-card">
                  <h3>{t("MCP 协议全局设置")}</h3>
                  <div className="settings-row">
                    <div>
                      <strong>{t("启用 MCP 外部工具协议")}</strong>
                      <small>{t("开启后，Agent 模式将允许检索并执行连接的 MCP 工具")}</small>
                    </div>
                    <SettingsToggle
                      checked={preferenceDraft.mcpEnabled ?? true}
                      label={preferenceDraft.mcpEnabled ?? true ? t("已启用") : t("已停用")}
                      onChange={(enabled) => setPreferenceDraft((curr) => ({ ...curr, mcpEnabled: enabled }))}
                    />
                  </div>
                  <div className="settings-row">
                    <div>
                      <strong>{t("工具智能检索模式")}</strong>
                      <small>{t("智能检索 (auto) 动态匹配最相关的工具；全部挂载 (all) 加载全部可用工具")}</small>
                    </div>
                    <div className="segmented-control">
                      <button
                        className={(preferenceDraft.mcpToolRetrievalMode ?? 'auto') === 'auto' ? 'is-active' : ''}
                        onClick={() => setPreferenceDraft((curr) => ({ ...curr, mcpToolRetrievalMode: 'auto' }))}
                      >{t("智能检索 (auto)")}</button>
                      <button
                        className={preferenceDraft.mcpToolRetrievalMode === 'all' ? 'is-active' : ''}
                        onClick={() => setPreferenceDraft((curr) => ({ ...curr, mcpToolRetrievalMode: 'all' }))}
                      >{t("全部挂载 (all)")}</button>
                    </div>
                  </div>
                  <div className="settings-row">
                    <div>
                      <strong>{t("工具调用审批策略")}</strong>
                      <small>{t("Full Access 会跳过代码、终端和 MCP 工具的全部审批")}</small>
                    </div>
                    <div className="segmented-control">
                      <button
                        className={preferenceDraft.mcpToolApprovalPolicy === 'always' ? 'is-active' : ''}
                        onClick={() => setPreferenceDraft((curr) => ({ ...curr, mcpToolApprovalPolicy: 'always' }))}
                      >{t("每次确认")}</button>
                      <button
                        className={(preferenceDraft.mcpToolApprovalPolicy ?? 'sensitive') === 'sensitive' ? 'is-active' : ''}
                        onClick={() => setPreferenceDraft((curr) => ({ ...curr, mcpToolApprovalPolicy: 'sensitive' }))}
                      >{t("智能确认")}</button>
                      <button
                        className={preferenceDraft.mcpToolApprovalPolicy === 'full-access' ? 'is-active' : ''}
                        onClick={() => setPreferenceDraft((curr) => ({ ...curr, mcpToolApprovalPolicy: 'full-access' }))}
                      >
                        {t('fullAccess.label')}
                      </button>
                    </div>
                  </div>
                  {preferenceDraft.mcpToolApprovalPolicy === 'full-access' && (
                    <div className="full-access-warning" role="alert">
                      <Icon name="shield" size={15} />
                      <span><strong>{t("Full Access 已开启")}</strong><small>{t("模型可直接执行终端命令、代码及有副作用的 MCP 工具。仅在你信任当前模型、服务和任务时使用。")}</small></span>
                    </div>
                  )}
                  <div className="settings-row">
                    <div>
                      <strong>{t("审批等待时限")}</strong>
                      <small>{t("永不超时仍可通过拒绝、停止生成、关闭会话或退出应用结束等待")}</small>
                    </div>
                    <div className="segmented-control">
                      <button
                        className={(preferenceDraft.toolApprovalTimeoutMode ?? 'five-minutes') === 'five-minutes' ? 'is-active' : ''}
                        onClick={() => setPreferenceDraft((curr) => ({ ...curr, toolApprovalTimeoutMode: 'five-minutes' }))}
                      >{t("5 分钟")}</button>
                      <button
                        className={preferenceDraft.toolApprovalTimeoutMode === 'never' ? 'is-active' : ''}
                        onClick={() => setPreferenceDraft((curr) => ({ ...curr, toolApprovalTimeoutMode: 'never' }))}
                      >{t("永不超时")}</button>
                    </div>
                  </div>
                </section>

                <div className="mcp-toolbar">
                  <div className="mcp-toolbar-left">
                    <div className="mcp-search-box">
                      <Icon name="search" size={15} />
                      <input
                        placeholder={t("搜索服务名称或描述…")}
                        value={mcpSearch}
                        onChange={(e) => setMcpSearch(e.target.value)}
                      />
                      {mcpSearch && (
                        <button className="icon-button" onClick={() => setMcpSearch('')} aria-label={t("清空搜索")}>
                          <Icon name="close" size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="mcp-toolbar-right">
                    <button className="mcp-action-btn" onClick={() => void openToolExplorerModal()}>
                      <Icon name="tool" size={14} />
                      <span>{t("工具总览 (Tool Explorer)")}</span>
                    </button>
                    <button className="mcp-action-btn is-primary" onClick={() => startEditMcpServer()}>
                      <Icon name="plus" size={14} />
                      <span>{t("添加 MCP 服务")}</span>
                    </button>
                  </div>
                </div>

                {mcpActionError && (
                  <div className="settings-error-banner" role="alert">
                    <Icon name="info" size={15} />
                    <span>{mcpActionError}</span>
                    <button className="icon-button" onClick={() => setMcpActionError('')}><Icon name="close" size={13} /></button>
                  </div>
                )}

                <div className="mcp-servers-grid">
                  {filteredMcpServers.length === 0 ? (
                    <div className="mcp-empty">
                      <Icon name="tool" size={32} />
                      <p>{t("未配置 MCP 服务")}</p>
                      <small>{t("点击上方「添加 MCP 服务」可接入本地命令行子进程或远程 Streamable HTTP 工具服务")}</small>
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
                                label={server.enabled ? t("已启用") : t("已停用")}
                                onChange={(enabled) => void handleToggleMcpServer(server.id, enabled)}
                              />
                            </div>
                          </div>

                          <div className="mcp-server-details">
                            {server.transport === 'stdio' ? (
                              <div className="mcp-detail-row">
                                <span className="mcp-detail-label">{t("命令:")}</span>
                                <code>{server.command} {(server.args || []).join(' ')}</code>
                              </div>
                            ) : (
                              <div className="mcp-detail-row">
                                <span className="mcp-detail-label">{t("端点:")}</span>
                                <code>{server.url}</code>
                              </div>
                            )}
                          </div>

                          {testResult && (
                            <div className={`mcp-test-status ${testResult.ok ? 'is-ok' : 'is-err'}`}>
                              <Icon name={testResult.ok ? 'check' : 'info'} size={13} />
                              <span>{testResult.message} ({testResult.latencyMs}ms)</span>
                            </div>
                          )}

                          <div className="mcp-card-footer">
                            <button
                              className="mcp-footer-btn"
                              disabled={isTesting}
                              onClick={() => void handleTestServerInList(server)}
                            >
                              {isTesting ? <span className="button-spinner" /> : <Icon name="refresh" size={13} />}
                              <span>{isTesting ? t("测试中…") : t("测试连接")}</span>
                            </button>
                            <button className="mcp-footer-btn" onClick={() => startEditMcpServer(server)}>
                              <Icon name="edit" size={13} />
                              <span>{t("编辑")}</span>
                            </button>
                            <button className="mcp-footer-btn is-danger" onClick={() => void handleRemoveMcpServer(server.id)}>
                              <Icon name="trash" size={13} />
                              <span>{t("删除")}</span>
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
                        <h3>{editingMcpServer.id ? t("编辑 MCP 服务") : t("新建 MCP 外部服务")}</h3>
                        <button className="icon-button" onClick={() => setEditingMcpServer(null)}><Icon name="close" size={16} /></button>
                      </header>
                      <div className="skill-modal-body">
                        <label className="skill-form-field">
                          <span>{t("服务名称 (必填)")}</span>
                          <input
                            placeholder={t("例如：文件系统服务 (Filesystem)")}
                            value={editingMcpServer.name}
                            onChange={(e) => setEditingMcpServer({ ...editingMcpServer, name: e.target.value })}
                          />
                        </label>
                        <label className="skill-form-field">
                          <span>{t("描述说明 (可选)")}</span>
                          <input
                            placeholder={t("例如：提供本地工作区文件的读取与写入能力")}
                            value={editingMcpServer.description || ''}
                            onChange={(e) => setEditingMcpServer({ ...editingMcpServer, description: e.target.value })}
                          />
                        </label>
                        <div className="skill-form-field">
                          <span>{t("传输协议类型")}</span>
                          <div className="segmented-control" style={{ width: '100%' }}>
                            <button
                              type="button"
                              className={editingMcpServer.transport === 'stdio' ? 'is-active' : ''}
                              onClick={() => setEditingMcpServer({ ...editingMcpServer, transport: 'stdio' })}
                            >{t("本地命令行子进程 (stdio)")}</button>
                            <button
                              type="button"
                              className={editingMcpServer.transport === 'http' ? 'is-active' : ''}
                              onClick={() => setEditingMcpServer({ ...editingMcpServer, transport: 'http' })}
                            >{t("远程 HTTP（自动兼容）")}</button>
                            <button
                              type="button"
                              className={editingMcpServer.transport === 'sse' ? 'is-active' : ''}
                              onClick={() => setEditingMcpServer({ ...editingMcpServer, transport: 'sse' })}
                            >{t("旧版 SSE")}</button>
                          </div>
                        </div>

                        {editingMcpServer.transport === 'stdio' ? (
                          <>
                            <label className="skill-form-field">
                              <span>{t("执行命令 (Command)")}</span>
                              <input
                                placeholder={t("例如：npx, uvx, node, python")}
                                value={editingMcpServer.command || ''}
                                onChange={(e) => setEditingMcpServer({ ...editingMcpServer, command: e.target.value })}
                              />
                            </label>
                            <label className="skill-form-field">
                              <span>{t("启动参数 (每行一个参数，换行分隔)")}</span>
                              <textarea
                                className="mono-input"
                                placeholder={"-y\n@modelcontextprotocol/server-filesystem\nC:\\Projects"}
                                rows={4}
                                value={editingMcpArgsText}
                                onChange={(e) => setEditingMcpArgsText(e.target.value)}
                              />
                            </label>
                            <div className="skill-form-field">
                              <div className="mcp-keyvalue-head">
                                <span>{t("环境变量 (Environment Variables)")}</span>
                                <button
                                  type="button"
                                  className="mcp-add-kv-btn"
                                  onClick={() => setEditingMcpEnvRows([...editingMcpEnvRows, { key: '', value: '' }])}
                                >
                                  <Icon name="plus" size={12} />{t("添加变量")}</button>
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
                              <span>{editingMcpServer.transport === 'sse' ? t("旧版 SSE 端点 URL") : t("MCP HTTP 端点 URL")}</span>
                              <input
                                placeholder={editingMcpServer.transport === 'sse' ? 'http://127.0.0.1:3000/sse' : t("http://127.0.0.1:3000/mcp 或 https://.../mcp")}
                                value={editingMcpServer.url || ''}
                                onChange={(e) => setEditingMcpServer({ ...editingMcpServer, url: e.target.value })}
                              />
                            </label>
                            <div className="skill-form-field">
                              <div className="mcp-keyvalue-head">
                                <span>{t("自定义请求头 (HTTP Headers)")}</span>
                                <button
                                  type="button"
                                  className="mcp-add-kv-btn"
                                  onClick={() => setEditingMcpHeadersRows([...editingMcpHeadersRows, { key: '', value: '' }])}
                                >
                                  <Icon name="plus" size={12} />{t("添加请求头")}</button>
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
                          <div className={`mcp-test-status ${modalTestResult.ok ? 'is-ok' : 'is-err'}`} style={{ marginTop: '12px' }}>
                            <Icon name={modalTestResult.ok ? 'check' : 'info'} size={14} />
                            <span>{modalTestResult.message} ({modalTestResult.latencyMs}ms)</span>
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
                          {modalTesting ? <><span className="button-spinner" />{t("测试中…")}</> : <><Icon name="refresh" size={14} />{t("测试连接")}</>}
                        </button>
                        <button className="secondary-button" onClick={() => setEditingMcpServer(null)}>{t("取消")}</button>
                        <button
                          className="primary-button"
                          disabled={!editingMcpServer.name.trim() || (editingMcpServer.transport === 'stdio' ? !editingMcpServer.command?.trim() : !editingMcpServer.url?.trim())}
                          onClick={() => void handleSaveMcpModal()}
                        >{t("保存服务")}</button>
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
                          <h3>{t("工具总览 (Tool Explorer)")}</h3>
                          <span className="tool-count-pill">{t("{value0} 个工具", { value0: allExploredTools.length })}</span>
                        </div>
                        <button className="icon-button" onClick={() => setToolExplorerOpen(false)}><Icon name="close" size={16} /></button>
                      </header>
                      <div className="skill-modal-body">
                        <div className="mcp-explorer-toolbar">
                          <div className="mcp-search-box">
                            <Icon name="search" size={14} />
                            <input
                              placeholder={t("搜索工具名称或描述…")}
                              value={toolExplorerSearch}
                              onChange={(e) => setToolExplorerSearch(e.target.value)}
                            />
                          </div>
                          <select
                            className="mcp-server-filter-select"
                            value={toolExplorerServerFilter}
                            onChange={(e) => setToolExplorerServerFilter(e.target.value)}
                          >
                            <option value="all">{t("全部来源 ({value0})", { value0: allExploredTools.length })}</option>
                            <option value={BUILTIN_TOOL_FILTER}>{t("系统内置 ({value0})", { value0: builtinExploredTools.length })}</option>
                            {mcpServersList.length > 0 && (
                              <optgroup label={t("MCP 外部服务")}>
                                {mcpServersList.map((s) => (
                                  <option key={s.id} value={s.id}>{s.name}</option>
                                ))}
                              </optgroup>
                            )}
                          </select>
                        </div>

                        {loadingTools ? (
                          <div className="mcp-loading-tools">
                            <span className="button-spinner large" />
                            <p>{t("正在检索 MCP 外部工具列表…")}</p>
                          </div>
                        ) : filteredExploredTools.length === 0 ? (
                          <div className="mcp-empty">
                            <p>{t("未发现匹配的工具")}</p>
                            <small>{t("可调整搜索或来源筛选，并确保 MCP 服务处于启用状态")}</small>
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
                                        <Icon name="sparkles" size={10} />{t("系统内置")}</span>
                                    )}
                                    <span className="mcp-tool-item-server">{tool.serverName}</span>
                                  </span>
                                </div>
                                <p className="mcp-tool-item-desc">{tool.description || t("无描述说明")}</p>
                                {tool.inputSchema?.properties && Object.keys(tool.inputSchema.properties).length > 0 && (
                                  <details className="mcp-tool-schema-details">
                                    <summary>{t("参数定义 ({value0})", { value0: Object.keys(tool.inputSchema.properties).length })}</summary>
                                    <pre><code>{JSON.stringify(tool.inputSchema, null, 2)}</code></pre>
                                  </details>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      <footer className="skill-modal-footer">
                        <button className="secondary-button" onClick={() => setToolExplorerOpen(false)}>{t('common.close')}</button>
                      </footer>
                    </div>
                  </div>
                )}
              </div>
  )
}
