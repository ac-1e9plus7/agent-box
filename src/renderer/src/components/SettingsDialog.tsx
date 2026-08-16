import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import type {
  ApiFormat,
  AppPreferences,
  ModelConfig,
  ProviderConfig,
  SettingsSection,
  WebSearchMode
} from '../types'
import type { ProviderRouting, RemoteModel } from '../../../shared/types'
import { API_FORMAT_LABELS } from '../types'
import { stepTokenValue } from '../token-step'
import { isWebSearchAvailable, WEB_SEARCH_MODE_LABELS } from '../web-search'
import { Icon } from './Icon'

export interface SettingsSavePayload {
  models: ModelConfig[]
  providers: ProviderConfig[]
  preferences: AppPreferences
  apiKeyInputs: Record<string, string>
  clearApiKeyIds: string[]
}

interface SettingsDialogProps {
  initialSection: SettingsSection
  models: ModelConfig[]
  open: boolean
  preferences: AppPreferences
  providers: ProviderConfig[]
  onClose: () => void
  onClearData?: () => Promise<void>
  onDiscoverModels?: (providerId: string) => Promise<RemoteModel[]>
  onSave: (payload: SettingsSavePayload) => void | Promise<void>
  onTestProvider?: (provider: ProviderConfig, apiKeyInput: string, clearApiKey: boolean) => Promise<boolean>
}

const settingsNav: Array<{ id: SettingsSection; label: string; icon: Parameters<typeof Icon>[0]['name'] }> = [
  { id: 'general', label: '通用', icon: 'settings' },
  { id: 'models', label: '模型', icon: 'sparkles' },
  { id: 'providers', label: '服务商', icon: 'globe' },
  { id: 'security', label: '数据与安全', icon: 'shield' },
  { id: 'about', label: '关于', icon: 'info' }
]

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function isLoopbackUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (hostname === 'localhost' || hostname === '::1') return true
    const octets = hostname.split('.')
    return octets.length === 4
      && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
      && Number(octets[0]) === 127
  } catch {
    return false
  }
}

function isProviderKeyOptional(provider: ProviderConfig): boolean {
  return provider.kind === 'cliproxy' && isLoopbackUrl(provider.baseUrl)
}

/**
 * Secure-by-default OpenRouter routing for newly created models: refuse
 * endpoints that retain user data and require Zero Data Retention endpoints.
 * Only takes effect on OpenRouter connections (other providers ignore the
 * `provider` field at send time), but is stored uniformly.
 */
function secureDefaultRouting(_providerId: string): ProviderRouting {
  return { dataCollection: 'deny', zdr: true }
}

function SettingsToggle({
  checked,
  disabled,
  label,
  onChange
}: {
  checked: boolean
  disabled?: boolean
  label: string
  onChange: (checked: boolean) => void
}): JSX.Element {
  return (
    <label className={`settings-toggle ${disabled ? 'is-disabled' : ''}`}>
      <input
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <span aria-hidden="true"><i /></span>
      <em>{label}</em>
    </label>
  )
}

function FieldLabel({ children, hint }: { children: ReactNode; hint?: string }): JSX.Element {
  return (
    <div className="field-label">
      <span>{children}</span>
      {hint && <small>{hint}</small>}
    </div>
  )
}

interface TokenStepperProps {
  ariaLabel: string
  maximum: number
  minimum: number
  onChange: (value: number) => void
  value: number
}

function TokenStepper({
  ariaLabel,
  maximum,
  minimum,
  onChange,
  value
}: TokenStepperProps): JSX.Element {
  const [inputValue, setInputValue] = useState(String(value))

  useEffect(() => {
    setInputValue(String(value))
  }, [value])

  const commitInput = (): void => {
    const parsed = Number(inputValue)
    if (!inputValue.trim() || !Number.isFinite(parsed)) {
      setInputValue(String(value))
      return
    }
    const normalized = Math.min(maximum, Math.max(minimum, Math.trunc(parsed)))
    setInputValue(String(normalized))
    onChange(normalized)
  }

  const applyButtonStep = (direction: 'decrease' | 'increase'): void => {
    const parsed = Number(inputValue)
    const current = inputValue.trim() && Number.isFinite(parsed) ? parsed : value
    const next = stepTokenValue(current, direction, { minimum, maximum })
    setInputValue(String(next))
    onChange(next)
  }

  return (
    <div className="token-stepper">
      <button
        aria-label={`减少${ariaLabel}`}
        disabled={value <= minimum}
        onClick={() => applyButtonStep('decrease')}
        title="按钮按 64K 调整，并在 2ⁿ、1M、2M 等关键值停靠"
        type="button"
      >
        <Icon name="minus" size={14} />
      </button>
      <input
        aria-label={ariaLabel}
        max={maximum}
        min={minimum}
        step="1"
        type="number"
        value={inputValue}
        onBlur={commitInput}
        onChange={(event) => setInputValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') {
            setInputValue(String(value))
            event.preventDefault()
          }
        }}
      />
      <button
        aria-label={`增加${ariaLabel}`}
        disabled={value >= maximum}
        onClick={() => applyButtonStep('increase')}
        title="按钮按 64K 调整，并在 2ⁿ、1M、2M 等关键值停靠"
        type="button"
      >
        <Icon name="plus" size={14} />
      </button>
    </div>
  )
}

export function SettingsDialog({
  initialSection,
  models,
  open,
  preferences,
  providers,
  onClose,
  onClearData,
  onDiscoverModels,
  onSave,
  onTestProvider
}: SettingsDialogProps): JSX.Element | null {
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection)
  const [modelDrafts, setModelDrafts] = useState<ModelConfig[]>(models)
  const [providerDrafts, setProviderDrafts] = useState<ProviderConfig[]>(providers)
  const [preferenceDraft, setPreferenceDraft] = useState<AppPreferences>(preferences)
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({})
  const [clearApiKeyIds, setClearApiKeyIds] = useState<string[]>([])
  const [selectedModelId, setSelectedModelId] = useState(models[0]?.id ?? '')
  const [selectedProviderId, setSelectedProviderId] = useState(providers[0]?.id ?? '')
  const [showApiKey, setShowApiKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [testState, setTestState] = useState<'idle' | 'testing' | 'success' | 'failed'>('idle')
  const [discovering, setDiscovering] = useState(false)
  const [remoteModels, setRemoteModels] = useState<RemoteModel[] | null>(null)
  const [modelsNeedingCalibration, setModelsNeedingCalibration] = useState<string[]>([])
  const [clearConfirming, setClearConfirming] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [clearError, setClearError] = useState('')

  const confirmClearData = async (): Promise<void> => {
    if (!onClearData) return
    setClearing(true)
    setClearError('')
    try {
      await onClearData()
      setClearConfirming(false)
      closeDialog()
    } catch (error) {
      setClearError(error instanceof Error ? error.message : '清除失败，请重试。')
    } finally {
      setClearing(false)
    }
  }

  const closeDialog = useCallback((): void => {
    setApiKeyInputs({})
    setClearApiKeyIds([])
    setShowApiKey(false)
    setSaveError('')
    onClose()
  }, [onClose])

  useEffect(() => {
    if (!open) return
    setActiveSection(initialSection)
    setModelDrafts(models.map((model) => ({ ...model })))
    setProviderDrafts(providers.map((provider) => ({ ...provider })))
    setPreferenceDraft({ ...preferences })
    setApiKeyInputs({})
    setClearApiKeyIds([])
    setSelectedModelId(models[0]?.id ?? '')
    setSelectedProviderId(providers[0]?.id ?? '')
    setShowApiKey(false)
    setTestState('idle')
    setDiscovering(false)
    setRemoteModels(null)
    setModelsNeedingCalibration([])
    setSaveError('')
  }, [initialSection, models, open, preferences, providers])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeDialog()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeDialog, open])

  const selectedModel = useMemo(
    () => modelDrafts.find((model) => model.id === selectedModelId),
    [modelDrafts, selectedModelId]
  )
  const selectedProvider = useMemo(
    () => providerDrafts.find((provider) => provider.id === selectedProviderId),
    [providerDrafts, selectedProviderId]
  )
  const selectedModelProvider = useMemo(
    () => providerDrafts.find((provider) => provider.id === selectedModel?.providerId),
    [providerDrafts, selectedModel?.providerId]
  )
  const providersRequiringNewKey = useMemo(() => providerDrafts.filter((provider) => {
    const original = providers.find((item) => item.id === provider.id)
    if (!original?.hasApiKey) return false
    const credentialScopeChanged = original.baseUrl !== provider.baseUrl || original.kind !== provider.kind
    return credentialScopeChanged
      && !(apiKeyInputs[provider.id] ?? '').trim()
      && !clearApiKeyIds.includes(provider.id)
  }), [apiKeyInputs, clearApiKeyIds, providerDrafts, providers])
  const selectedProviderNeedsNewKey = providersRequiringNewKey.some((provider) => provider.id === selectedProviderId)
  const selectedProviderKeyOptional = selectedProvider ? isProviderKeyOptional(selectedProvider) : false
  const selectedModelApiFormat = selectedModel?.apiFormat ?? selectedModelProvider?.apiFormat
  const selectedModelWebSearchAvailable = isWebSearchAvailable(selectedModel, selectedModelProvider)

  if (!open) return null

  const updateModel = (patch: Partial<ModelConfig>): void => {
    setModelDrafts((current) => current.map((model) => (
      model.id === selectedModelId ? { ...model, ...patch } : model
    )))
  }

  const updateProvider = (patch: Partial<ProviderConfig>): void => {
    setProviderDrafts((current) => current.map((provider) => (
      provider.id === selectedProviderId ? { ...provider, ...patch } : provider
    )))
  }

  const addModel = (): void => {
    const id = uniqueId('model')
    setModelDrafts((current) => [
      ...current,
      {
        id,
        name: '新模型',
        remoteId: '',
        providerId: providerDrafts[0]?.id ?? '',
        apiFormat: 'openai-chat-completions',
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        supportsReasoning: false,
        defaultReasoningEnabled: false,
        defaultReasoningEffort: preferenceDraft.defaultReasoningEffort,
        defaultWebSearchMode: 'off',
        anthropicThinkingMode: 'adaptive',
        providerRouting: secureDefaultRouting(providerDrafts[0]?.id ?? ''),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ])
    setSelectedModelId(id)
  }

  const removeModel = (): void => {
    if (!selectedModel || modelDrafts.length <= 1) return
    const nextModels = modelDrafts.filter((model) => model.id !== selectedModel.id)
    setModelDrafts(nextModels)
    setSelectedModelId(nextModels[0]?.id ?? '')
  }

  const discoverModels = async (): Promise<void> => {
    const providerId = selectedModelProvider?.id ?? providerDrafts[0]?.id
    if (!providerId || !onDiscoverModels) return
    setDiscovering(true)
    setSaveError('')
    try {
      setRemoteModels(await onDiscoverModels(providerId))
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '无法获取远程模型列表。')
    } finally {
      setDiscovering(false)
    }
  }

  const addDiscoveredModel = (remoteModel: RemoteModel): void => {
    const id = uniqueId('model')
    const now = new Date().toISOString()
    setModelDrafts((current) => [
      ...current,
      {
        id,
        name: remoteModel.name || remoteModel.id,
        providerId: selectedModelProvider?.id ?? providerDrafts[0]?.id ?? '',
        remoteId: remoteModel.id,
        contextWindow: remoteModel.contextWindow ?? 128_000,
        maxOutputTokens: remoteModel.maxOutputTokens ?? 8_192,
        supportsReasoning: remoteModel.supportsReasoning ?? false,
        defaultReasoningEnabled: false,
        defaultReasoningEffort: preferenceDraft.defaultReasoningEffort,
        defaultWebSearchMode: 'off',
        anthropicThinkingMode: 'adaptive',
        providerRouting: secureDefaultRouting(selectedModelProvider?.id ?? providerDrafts[0]?.id ?? ''),
        createdAt: now,
        updatedAt: now
      }
    ])
    setSelectedModelId(id)
    if (
      remoteModel.contextWindow === undefined
      || remoteModel.maxOutputTokens === undefined
      || remoteModel.supportsReasoning === undefined
    ) {
      setModelsNeedingCalibration((current) => [...current, id])
    }
    setRemoteModels(null)
  }

  const addProvider = (): void => {
    const id = uniqueId('provider')
    setProviderDrafts((current) => [
      ...current,
      {
        id,
        name: '自定义服务商',
        kind: 'custom',
        baseUrl: 'https://api.example.com/v1',
        apiFormat: 'openai-chat-completions',
        hasApiKey: false,
        apiKeyOptional: false,
        defaultHeaders: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ])
    setSelectedProviderId(id)
  }

  const addCliProxyPreset = (): void => {
    const existing = providerDrafts.find((provider) => provider.kind === 'cliproxy')
    if (existing) {
      setSelectedProviderId(existing.id)
      return
    }
    const id = uniqueId('provider')
    const now = new Date().toISOString()
    setProviderDrafts((current) => [
      ...current,
      {
        id,
        name: 'CLIProxyAPI（本地）',
        kind: 'cliproxy',
        baseUrl: 'http://127.0.0.1:8317/v1',
        apiFormat: 'openai-chat-completions',
        hasApiKey: false,
        apiKeyOptional: true,
        defaultHeaders: {},
        createdAt: now,
        updatedAt: now
      }
    ])
    setSelectedProviderId(id)
  }

  const removeProvider = (): void => {
    if (!selectedProvider || selectedProvider.kind === 'openrouter' || providerDrafts.length <= 1) return
    const nextProviders = providerDrafts.filter((provider) => provider.id !== selectedProvider.id)
    const replacementProviderId = nextProviders[0]?.id ?? ''
    setProviderDrafts(nextProviders)
    setModelDrafts((current) => current.map((model) => (
      model.providerId === selectedProvider.id ? { ...model, providerId: replacementProviderId } : model
    )))
    setSelectedProviderId(nextProviders[0]?.id ?? '')
  }

  const toggleClearApiKey = (providerId: string): void => {
    const willClear = !clearApiKeyIds.includes(providerId)
    setClearApiKeyIds((current) => willClear
      ? [...current, providerId]
      : current.filter((id) => id !== providerId))
    if (willClear) {
      setApiKeyInputs((current) => ({ ...current, [providerId]: '' }))
    }
  }

  const save = async (): Promise<void> => {
    if (providersRequiringNewKey.length > 0) {
      setSaveError(`“${providersRequiringNewKey[0]?.name ?? '服务商'}”的连接地址或类型已更改，请重新输入 API 密钥。`)
      return
    }
    setSaving(true)
    setSaveError('')
    try {
      await onSave({
        models: modelDrafts,
        providers: providerDrafts,
        preferences: preferenceDraft,
        apiKeyInputs,
        clearApiKeyIds
      })
      setApiKeyInputs({})
      closeDialog()
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '保存失败，请检查配置后重试。')
    } finally {
      setSaving(false)
    }
  }

  const testProvider = async (): Promise<void> => {
    if (!selectedProvider || !onTestProvider) return
    setTestState('testing')
    try {
      const success = await onTestProvider(
        selectedProvider,
        apiKeyInputs[selectedProvider.id] ?? '',
        clearApiKeyIds.includes(selectedProvider.id)
      )
      setTestState(success ? 'success' : 'failed')
    } catch {
      setTestState('failed')
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) closeDialog()
    }}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-label="设置">
        <aside className="settings-sidebar">
          <div className="settings-brand">
            <span className="brand-mark"><Icon name="app" size={21} /></span>
            <span>ChatBox Lite</span>
          </div>
          <nav>
            {settingsNav.map((item) => (
              <button
                className={activeSection === item.id ? 'is-active' : ''}
                key={item.id}
                onClick={() => setActiveSection(item.id)}
              >
                <Icon name={item.icon} size={17} />
                {item.label}
              </button>
            ))}
          </nav>
          <div className="settings-secure-note">
            <Icon name="lock" size={15} />
            <span><strong>隐私优先</strong><small>密钥与数据仅存于本机</small></span>
          </div>
        </aside>

        <div className="settings-main">
          <header className="settings-header">
            <div>
              <h2>{settingsNav.find((item) => item.id === activeSection)?.label}</h2>
              <p>{activeSection === 'models' && '配置模型能力、上下文窗口与请求格式'}</p>
              <p>{activeSection === 'providers' && '管理 API 端点与访问密钥'}</p>
              <p>{activeSection === 'general' && '调整 ChatBox Lite 的使用偏好'}</p>
              <p>{activeSection === 'security' && '了解本地加密与系统安全存储'}</p>
            </div>
            <button className="icon-button" aria-label="关闭设置" onClick={closeDialog}><Icon name="close" /></button>
          </header>

          <div className="settings-content">
            {activeSection === 'general' && (
              <div className="settings-section-content narrow-settings">
                <section className="settings-card">
                  <h3>外观</h3>
                  <div className="settings-row">
                    <div><strong>主题</strong><small>跟随系统或使用固定主题</small></div>
                    <div className="segmented-control">
                      {(['system', 'light', 'dark'] as const).map((theme) => (
                        <button
                          className={preferenceDraft.theme === theme ? 'is-active' : ''}
                          key={theme}
                          onClick={() => setPreferenceDraft((current) => ({ ...current, theme }))}
                        >
                          {theme === 'system' ? '跟随系统' : theme === 'light' ? '浅色' : '深色'}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="settings-row">
                    <div><strong>新会话默认思考</strong><small>支持推理的模型将自动开启</small></div>
                    <SettingsToggle
                      checked={preferenceDraft.defaultReasoningEnabled}
                      label="新会话默认思考"
                      onChange={(defaultReasoningEnabled) => setPreferenceDraft((current) => ({ ...current, defaultReasoningEnabled }))}
                    />
                  </div>
                  <div className="settings-row">
                    <div><strong>新模型思考强度</strong><small>添加模型时作为默认初始值，可在模型页单独调整</small></div>
                    <select
                      value={preferenceDraft.defaultReasoningEffort}
                      onChange={(event) => setPreferenceDraft((current) => ({
                        ...current,
                        defaultReasoningEffort: event.target.value as AppPreferences['defaultReasoningEffort']
                      }))}
                    >
                      <option value="minimal">极简</option>
                      <option value="low">低</option>
                      <option value="medium">中</option>
                      <option value="high">高</option>
                      <option value="xhigh">很高</option>
                      <option value="max">最高</option>
                    </select>
                  </div>
                </section>
                <section className="settings-card">
                  <h3>输入</h3>
                  <div className="settings-row">
                    <div><strong>按 Enter 发送</strong><small>关闭后使用 ⌘/Ctrl + Enter 发送</small></div>
                    <SettingsToggle
                      checked={preferenceDraft.sendShortcut === 'enter'}
                      label="按 Enter 发送"
                      onChange={(sendOnEnter) => setPreferenceDraft((current) => ({
                        ...current,
                        sendShortcut: sendOnEnter ? 'enter' : 'mod-enter'
                      }))}
                    />
                  </div>
                  <label className="system-prompt-field">
                    <FieldLabel hint="每次请求时添加，可留空">系统提示词</FieldLabel>
                    <textarea
                      placeholder="例如：请始终使用简体中文回答…"
                      rows={5}
                      value={preferenceDraft.systemPrompt}
                      onChange={(event) => setPreferenceDraft((current) => ({ ...current, systemPrompt: event.target.value }))}
                    />
                  </label>
                  <div className="settings-row" style={{ marginTop: '16px' }}>
                    <div><strong>自动命名模型</strong><small>对话产生时自动生成标题所用的模型</small></div>
                    <select
                      value={preferenceDraft.titleGenerationModelId ?? ''}
                      onChange={(event) => setPreferenceDraft((current) => ({
                        ...current,
                        titleGenerationModelId: event.target.value === '' ? undefined : event.target.value
                      }))}
                    >
                      <option value="">跟随当前会话模型</option>
                      {models.map((model) => (
                        <option key={model.id} value={model.id}>{model.name}</option>
                      ))}
                    </select>
                  </div>
                </section>
                <section className="settings-card context-policy-card">
                  <h3>上下文管理</h3>
                  <div className="context-policy-options">
                    <button
                      className={preferenceDraft.contextManagementMode === 'manual' ? 'is-active' : ''}
                      onClick={() => setPreferenceDraft((current) => ({ ...current, contextManagementMode: 'manual' }))}
                    >
                      <span className="policy-radio"><i /></span>
                      <span>
                        <strong>手动管理 <em>默认</em></strong>
                        <small>保留全部历史。超过模型可用上下文时会阻止发送，由你调整会话或上下文窗口。</small>
                      </span>
                    </button>
                    <button
                      className={preferenceDraft.contextManagementMode === 'auto' ? 'is-active' : ''}
                      onClick={() => setPreferenceDraft((current) => ({ ...current, contextManagementMode: 'auto' }))}
                    >
                      <span className="policy-radio"><i /></span>
                      <span>
                        <strong>自动裁剪</strong>
                        <small>超限时从最早的对话开始，按完整的用户＋助手轮次裁剪；系统提示词与最新问题始终保留。</small>
                      </span>
                    </button>
                  </div>
                </section>
                <section className="settings-card context-policy-card">
                  <h3>网络代理</h3>
                  <div className="context-policy-options">
                    <button
                      className={preferenceDraft.proxy.mode === 'off' ? 'is-active' : ''}
                      onClick={() => setPreferenceDraft((current) => ({
                        ...current,
                        proxy: { ...current.proxy, mode: 'off' }
                      }))}
                    >
                      <span className="policy-radio"><i /></span>
                      <span>
                        <strong>关闭 <em>默认</em></strong>
                        <small>直连所有供应商，不经过代理。</small>
                      </span>
                    </button>
                    <button
                      className={preferenceDraft.proxy.mode === 'custom' ? 'is-active' : ''}
                      onClick={() => setPreferenceDraft((current) => ({
                        ...current,
                        proxy: { ...current.proxy, mode: 'custom' }
                      }))}
                    >
                      <span className="policy-radio"><i /></span>
                      <span>
                        <strong>自定义代理</strong>
                        <small>转发所有模型请求；本地代理可用 http，远程代理请使用 https。</small>
                      </span>
                    </button>
                  </div>
                  {preferenceDraft.proxy.mode === 'custom' && (
                    <label className="system-prompt-field">
                      <FieldLabel hint="支持 http://（仅本机）与 https://，可在地址中包含用户名密码">代理地址</FieldLabel>
                      <input
                        className="mono-input"
                        placeholder="例如：http://127.0.0.1:7890"
                        value={preferenceDraft.proxy.url}
                        onChange={(event) => setPreferenceDraft((current) => ({
                          ...current,
                          proxy: { ...current.proxy, url: event.target.value }
                        }))}
                      />
                    </label>
                  )}
                </section>
              </div>
            )}

            {activeSection === 'models' && (
              <div className="settings-split-view">
                <aside className="settings-list-panel">
                  <div className="settings-list-toolbar">
                    <span>{modelDrafts.length} 个模型</span>
                    <div>
                      <button disabled={!onDiscoverModels || discovering} onClick={() => void discoverModels()}>
                        {discovering ? <span className="button-spinner" /> : <Icon name="refresh" size={14} />} 获取
                      </button>
                      <button onClick={addModel}><Icon name="plus" size={15} /> 添加</button>
                    </div>
                  </div>
                  {remoteModels && (
                    <div className="remote-model-picker">
                      <header><strong>选择远程模型</strong><button aria-label="关闭模型列表" onClick={() => setRemoteModels(null)}><Icon name="close" size={14} /></button></header>
                      <div>
                        {remoteModels.slice(0, 100).map((remoteModel) => (
                          <button key={remoteModel.id} onClick={() => addDiscoveredModel(remoteModel)}>
                            <span><strong>{remoteModel.name || remoteModel.id}</strong><small>{remoteModel.id}</small></span>
                            <Icon name="plus" size={14} />
                          </button>
                        ))}
                        {remoteModels.length === 0 && <p>服务商没有返回可用模型。</p>}
                      </div>
                    </div>
                  )}
                  <div className="settings-entity-list">
                    {modelDrafts.map((model) => {
                      const provider = providerDrafts.find((item) => item.id === model.providerId)
                      return (
                        <button
                          className={selectedModelId === model.id ? 'is-active' : ''}
                          key={model.id}
                          onClick={() => setSelectedModelId(model.id)}
                        >
                          <span className="entity-icon"><Icon name="sparkles" size={16} /></span>
                          <span><strong>{model.name || '未命名模型'}</strong><small>{provider?.name ?? '未选择服务商'}</small></span>
                        </button>
                      )
                    })}
                  </div>
                </aside>
                {selectedModel && (
                  <div className="settings-editor">
                    <div className="editor-title-row">
                      <div>
                        <span className="entity-icon large"><Icon name="sparkles" size={18} /></span>
                        <div><h3>{selectedModel.name || '未命名模型'}</h3><small>{selectedModel.remoteId || '填写模型标识'}</small></div>
                      </div>
                      <span className="settings-value-note">已配置</span>
                    </div>

                    <div className="editor-form-grid">
                      <label>
                        <FieldLabel>显示名称</FieldLabel>
                        <input value={selectedModel.name} onChange={(event) => updateModel({ name: event.target.value })} />
                      </label>
                      <label>
                        <FieldLabel hint="OpenRouter 模型 slug">模型 ID</FieldLabel>
                        <input
                          className="mono-input"
                          placeholder="anthropic/claude-sonnet-4"
                          value={selectedModel.remoteId}
                          onChange={(event) => updateModel({ remoteId: event.target.value })}
                        />
                      </label>
                      <label>
                        <FieldLabel>服务商</FieldLabel>
                        <select value={selectedModel.providerId} onChange={(event) => {
                          const providerId = event.target.value
                          const nextProvider = providerDrafts.find((provider) => provider.id === providerId)
                          updateModel({
                            providerId,
                            ...(nextProvider?.kind === 'openrouter' ? {} : { defaultWebSearchMode: 'off' })
                          })
                        }}>
                          {providerDrafts.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                        </select>
                      </label>
                      <label>
                        <FieldLabel hint="按模型或端点指定">API 格式</FieldLabel>
                        <select
                          value={selectedModel.apiFormat ?? providerDrafts.find((provider) => provider.id === selectedModel.providerId)?.apiFormat ?? 'openai-chat-completions'}
                          onChange={(event) => updateModel({ apiFormat: event.target.value as ApiFormat })}
                        >
                          {(Object.keys(API_FORMAT_LABELS) as ApiFormat[]).map((format) => (
                            <option key={format} value={format}>{API_FORMAT_LABELS[format]}</option>
                          ))}
                        </select>
                      </label>
                      <div className="token-field">
                        <FieldLabel hint="± 按钮以 64K 为步长">上下文窗口</FieldLabel>
                        <TokenStepper
                          ariaLabel="上下文窗口"
                          maximum={100_000_000}
                          minimum={1_024}
                          value={selectedModel.contextWindow}
                          onChange={(contextWindow) => updateModel({ contextWindow })}
                        />
                      </div>
                      <div className="token-field">
                        <FieldLabel hint="± 按钮以 64K 为步长">最大输出 Token</FieldLabel>
                        <TokenStepper
                          ariaLabel="最大输出 Token"
                          maximum={10_000_000}
                          minimum={256}
                          value={selectedModel.maxOutputTokens}
                          onChange={(maxOutputTokens) => updateModel({ maxOutputTokens })}
                        />
                      </div>
                    </div>

                    {modelsNeedingCalibration.includes(selectedModel.id) && (
                      <div className="model-calibration-warning">
                        <Icon name="info" size={16} />
                        <span><strong>远程接口未返回完整模型能力</strong><small>当前缺失项使用通用默认值。保存前请手工校准上下文窗口、最大输出 Token 和思考支持。</small></span>
                        <button onClick={() => setModelsNeedingCalibration((current) => current.filter((id) => id !== selectedModel.id))}>知道了</button>
                      </div>
                    )}

                    {selectedModelProvider?.kind === 'openrouter' && (
                      <section className="routing-card">
                        <div className="routing-heading">
                          <span className="entity-icon provider-icon"><Icon name="globe" size={16} /></span>
                          <div>
                            <strong>OpenRouter 上游供应商</strong>
                            <small>限定该模型实际由哪些 provider 提供推理</small>
                          </div>
                        </div>
                        <label className="routing-only-field">
                          <FieldLabel hint="逗号分隔；留空为自动选择">指定供应商 slug</FieldLabel>
                          <input
                            className="mono-input"
                            placeholder="anthropic, openai"
                            value={selectedModel.providerRouting?.only?.join(', ') ?? ''}
                            onChange={(event) => {
                              const only = event.target.value.split(',').map((item) => item.trim()).filter(Boolean)
                              updateModel({
                                providerRouting: {
                                  ...selectedModel.providerRouting,
                                  only: only.length ? only : undefined
                                }
                              })
                            }}
                          />
                        </label>
                        <div className="routing-grid">
                          <label>
                            <FieldLabel>排序偏好</FieldLabel>
                            <select
                              value={selectedModel.providerRouting?.sort ?? ''}
                              onChange={(event) => updateModel({
                                providerRouting: {
                                  ...selectedModel.providerRouting,
                                  sort: (event.target.value || undefined) as 'price' | 'throughput' | 'latency' | undefined
                                }
                              })}
                            >
                              <option value="">OpenRouter 自动</option>
                              <option value="price">价格优先</option>
                              <option value="latency">低延迟优先</option>
                              <option value="throughput">吞吐优先</option>
                            </select>
                          </label>
                          <label>
                            <FieldLabel>数据收集策略</FieldLabel>
                            <select
                              value={selectedModel.providerRouting?.dataCollection ?? 'deny'}
                              onChange={(event) => updateModel({
                                providerRouting: {
                                  ...selectedModel.providerRouting,
                                  dataCollection: event.target.value as 'allow' | 'deny'
                                }
                              })}
                            >
                              <option value="allow">允许</option>
                              <option value="deny">禁止</option>
                            </select>
                          </label>
                        </div>
                        <div className="routing-toggles">
                          <div><span><strong>允许回退</strong><small>首选供应商不可用时切换到其他供应商</small></span><SettingsToggle
                            checked={selectedModel.providerRouting?.allowFallbacks ?? true}
                            label="允许供应商回退"
                            onChange={(allowFallbacks) => updateModel({
                              providerRouting: { ...selectedModel.providerRouting, allowFallbacks }
                            })}
                          /></div>
                          <div><span><strong>仅使用零数据保留端点</strong><small>要求上游声明 ZDR 支持</small></span><SettingsToggle
                            checked={selectedModel.providerRouting?.zdr ?? true}
                            label="仅使用 ZDR 端点"
                            onChange={(zdr) => updateModel({
                              providerRouting: { ...selectedModel.providerRouting, zdr }
                            })}
                          /></div>
                        </div>
                      </section>
                    )}

                    {selectedModelApiFormat === 'anthropic-messages' && (
                      <div className="anthropic-thinking-card">
                        <div><Icon name="brain" size={18} /><span><strong>Anthropic 思考协议</strong><small>根据 Claude 版本选择兼容模式</small></span></div>
                        <select
                          value={selectedModel.anthropicThinkingMode ?? 'adaptive'}
                          onChange={(event) => updateModel({ anthropicThinkingMode: event.target.value as 'adaptive' | 'manual' })}
                        >
                          <option value="adaptive">Adaptive（Claude 4.6+）</option>
                          <option value="manual">固定预算（Claude 4.5 及更早）</option>
                        </select>
                      </div>
                    )}

                    {selectedModelWebSearchAvailable && (
                      <div className="model-capability-card web-search-capability-card">
                        <div>
                          <Icon name="globe" size={18} />
                          <span>
                            <strong>新会话默认联网模式</strong>
                            <small>仅 OpenRouter 连接可用；旧会话保持关闭</small>
                          </span>
                        </div>
                        <select
                          aria-label="新会话默认联网模式"
                          value={selectedModel.defaultWebSearchMode ?? 'off'}
                          onChange={(event) => updateModel({ defaultWebSearchMode: event.target.value as WebSearchMode })}
                        >
                          {(Object.entries(WEB_SEARCH_MODE_LABELS) as Array<[WebSearchMode, string]>).map(([mode, label]) => (
                            <option key={mode} value={mode}>{label}</option>
                          ))}
                        </select>
                      </div>
                    )}

                    <div className="model-capability-card">
                      <div><Icon name="brain" size={18} /><span><strong>思考模式</strong><small>允许在聊天时开启或关闭模型推理</small></span></div>
                      <SettingsToggle
                        checked={selectedModel.supportsReasoning}
                        label="支持思考模式"
                        onChange={(supportsReasoning) => updateModel({
                          supportsReasoning,
                          defaultReasoningEnabled: supportsReasoning ? selectedModel.defaultReasoningEnabled : false
                        })}
                      />
                    </div>
                    <div className="model-capability-card nested-capability">
                      <div><span><strong>仅新会话默认开启</strong><small>只影响之后新建的会话，不会修改已有会话</small></span></div>
                      <SettingsToggle
                        checked={selectedModel.defaultReasoningEnabled}
                        disabled={!selectedModel.supportsReasoning}
                        label="新会话默认开启思考"
                        onChange={(defaultReasoningEnabled) => updateModel({ defaultReasoningEnabled })}
                      />
                    </div>
                    <div className="model-capability-card nested-capability">
                      <div><span><strong>默认思考强度</strong><small>该模型开启思考时使用的 effort</small></span></div>
                      <select
                        aria-label="模型默认思考强度"
                        disabled={!selectedModel.supportsReasoning}
                        value={selectedModel.defaultReasoningEffort}
                        onChange={(event) => updateModel({
                          defaultReasoningEffort: event.target.value as ModelConfig['defaultReasoningEffort']
                        })}
                      >
                        <option value="minimal">极简</option>
                        <option value="low">低</option>
                        <option value="medium">中</option>
                        <option value="high">高</option>
                        <option value="xhigh">很高</option>
                        <option value="max">最高</option>
                      </select>
                    </div>

                    <div className="danger-row">
                      <button disabled={modelDrafts.length <= 1} onClick={removeModel}><Icon name="trash" size={15} /> 删除模型</button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeSection === 'providers' && (
              <div className="settings-split-view">
                <aside className="settings-list-panel">
                  <div className="settings-list-toolbar">
                    <span>{providerDrafts.length} 个服务商</span>
                    <button onClick={addProvider}><Icon name="plus" size={15} /> 添加</button>
                  </div>
                  <button className="cliproxy-preset-button" onClick={addCliProxyPreset}>
                    <span><Icon name="code" size={17} /></span>
                    <span><strong>CLIProxyAPI 本地预设</strong><small>127.0.0.1:8317 · 密钥可选</small></span>
                    <Icon name="plus" size={14} />
                  </button>
                  <div className="settings-entity-list">
                    {providerDrafts.map((provider) => (
                      <button
                        className={selectedProviderId === provider.id ? 'is-active' : ''}
                        key={provider.id}
                        onClick={() => { setSelectedProviderId(provider.id); setTestState('idle') }}
                      >
                        <span className="entity-icon provider-icon"><Icon name="globe" size={16} /></span>
                        <span><strong>{provider.name}</strong><small>{provider.hasApiKey ? '密钥已保存' : isProviderKeyOptional(provider) ? '本机连接 · 密钥可选' : '需要 API 密钥'}</small></span>
                        <i className={`status-dot ${provider.hasApiKey || isProviderKeyOptional(provider) ? 'is-ready' : ''}`} />
                      </button>
                    ))}
                  </div>
                </aside>
                {selectedProvider && (
                  <div className="settings-editor provider-editor">
                    <div className="editor-title-row">
                      <div>
                        <span className="entity-icon large provider-icon"><Icon name="globe" size={18} /></span>
                        <div><h3>{selectedProvider.name}</h3><small>{selectedProvider.id === 'openrouter' ? '内置服务商' : selectedProvider.kind === 'cliproxy' ? '本机兼容代理' : '自定义服务商'}</small></div>
                      </div>
                      <span className="settings-value-note">{clearApiKeyIds.includes(selectedProvider.id) ? '密钥待清除' : selectedProvider.hasApiKey ? '密钥已保存' : selectedProviderKeyOptional ? '密钥可选' : '待配置'}</span>
                    </div>
                    <div className="editor-form-grid single-column">
                      <label>
                        <FieldLabel>名称</FieldLabel>
                        <input value={selectedProvider.name} onChange={(event) => updateProvider({ name: event.target.value })} />
                      </label>
                      <label>
                        <FieldLabel>服务商类型</FieldLabel>
                        <select value={selectedProvider.kind} onChange={(event) => updateProvider({ kind: event.target.value as ProviderConfig['kind'] })}>
                          <option value="openrouter">OpenRouter</option>
                          <option value="openai">OpenAI 兼容</option>
                          <option value="anthropic">Anthropic</option>
                          <option value="cliproxy">CLIProxyAPI（本机）</option>
                          <option value="custom">自定义</option>
                        </select>
                      </label>
                      <label>
                        <FieldLabel>默认 API 格式</FieldLabel>
                        <select value={selectedProvider.apiFormat} onChange={(event) => updateProvider({ apiFormat: event.target.value as ApiFormat })}>
                          {(Object.keys(API_FORMAT_LABELS) as ApiFormat[]).map((format) => (
                            <option key={format} value={format}>{API_FORMAT_LABELS[format]}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <FieldLabel hint={selectedProvider.kind === 'cliproxy' ? 'CLIProxyAPI 默认本机监听地址' : '请求将发送到此地址'}>Base URL</FieldLabel>
                        <input
                          className="mono-input"
                          placeholder={selectedProvider.kind === 'cliproxy' ? 'http://127.0.0.1:8317/v1' : 'https://openrouter.ai/api/v1'}
                          value={selectedProvider.baseUrl}
                          onChange={(event) => updateProvider({ baseUrl: event.target.value })}
                        />
                      </label>
                      <label>
                        <FieldLabel hint={selectedProviderKeyOptional ? 'config.yaml 的 api-keys 为空时可留空' : selectedProvider.hasApiKey ? '已加密保存；留空则保持不变' : '保存后将由系统安全加密'}>API 密钥</FieldLabel>
                        <div className="secret-input">
                          <Icon name="key" size={16} />
                          <input
                            autoComplete="off"
                            placeholder={clearApiKeyIds.includes(selectedProvider.id) ? '保存后将清除密钥；输入新值可取消' : selectedProvider.hasApiKey ? '••••••••••••••••••••' : selectedProviderKeyOptional ? '可选：填写 CLIProxyAPI 配置的密钥' : 'sk-or-v1-…'}
                            type={showApiKey ? 'text' : 'password'}
                            value={apiKeyInputs[selectedProvider.id] ?? ''}
                            onChange={(event) => {
                              const value = event.target.value
                              setApiKeyInputs((current) => ({ ...current, [selectedProvider.id]: value }))
                              if (value.trim()) setClearApiKeyIds((current) => current.filter((id) => id !== selectedProvider.id))
                            }}
                          />
                          <button type="button" onClick={() => setShowApiKey((current) => !current)}>{showApiKey ? '隐藏' : '显示'}</button>
                        </div>
                        {selectedProvider.hasApiKey && (
                          <button
                            className={`clear-secret-button ${clearApiKeyIds.includes(selectedProvider.id) ? 'is-active' : ''}`}
                            type="button"
                            onClick={() => toggleClearApiKey(selectedProvider.id)}
                          >
                            <Icon name={clearApiKeyIds.includes(selectedProvider.id) ? 'refresh' : 'trash'} size={13} />
                            {clearApiKeyIds.includes(selectedProvider.id) ? '保留原密钥' : '保存时清除密钥'}
                          </button>
                        )}
                        {selectedProviderNeedsNewKey && (
                          <span className="credential-warning">
                            <Icon name="info" size={13} /> 连接地址或服务商类型已改变。安全策略会清除旧密钥，请重新输入。
                          </span>
                        )}
                      </label>
                    </div>
                    <div className="provider-security-banner">
                      <Icon name="shield" size={18} />
                      <div><strong>{selectedProviderKeyOptional ? '本机回环连接可无密钥使用' : '密钥不会进入 renderer 持久状态'}</strong><p>{selectedProviderKeyOptional ? '若 CLIProxyAPI 的 api-keys 未配置，请保持为空；填写时仍会安全加密。' : '保存时通过安全通道交给主进程，并使用系统密钥链派生的密钥加密。'}</p></div>
                    </div>
                    {selectedProviderKeyOptional
                      && (!selectedProvider.hasApiKey || clearApiKeyIds.includes(selectedProvider.id))
                      && !(apiKeyInputs[selectedProvider.id] ?? '').trim() && (
                      <div className="cliproxy-network-warning">
                        <Icon name="info" size={17} />
                        <div><strong>无密钥时必须限制服务端监听地址</strong><p>请在 CLIProxyAPI 的 config.yaml 中设置 <code>host: "127.0.0.1"</code>。默认 <code>host: ""</code> 可能允许局域网访问，且默认未启用 TLS。</p></div>
                      </div>
                    )}
                    <div className="provider-actions">
                      <button
                        className={`test-connection-button ${testState === 'success' ? 'is-success' : ''}`}
                        disabled={!onTestProvider || testState === 'testing' || selectedProviderNeedsNewKey || ((!selectedProvider.hasApiKey || clearApiKeyIds.includes(selectedProvider.id)) && !selectedProviderKeyOptional && !(apiKeyInputs[selectedProvider.id] ?? '').trim())}
                        onClick={testProvider}
                      >
                        {testState === 'testing' ? <><span className="button-spinner" /> 测试中…</> :
                          testState === 'success' ? <><Icon name="check" size={15} /> 连接成功</> :
                            testState === 'failed' ? <><Icon name="info" size={15} /> 重试连接</> :
                              <><Icon name="refresh" size={15} /> 测试当前配置</>}
                      </button>
                      {selectedProvider.id !== 'openrouter' && (
                        <button className="remove-provider-button" onClick={removeProvider}><Icon name="trash" size={15} /> 删除</button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeSection === 'security' && (
              <div className="settings-section-content narrow-settings">
                <div className="encryption-hero">
                  <span><Icon name="shield" size={29} /></span>
                  <div><h3>本地数据保护已启用</h3><p>会话、配置与 API 密钥在写入磁盘前都会加密。</p></div>
                  <i><Icon name="check" size={14} /> 已保护</i>
                </div>
                <section className="settings-card">
                  <div className="settings-row">
                    <div><strong>API 密钥</strong><small>由操作系统凭据保护机制加密</small></div>
                    <span className="security-state"><Icon name="check" size={14} /> 安全</span>
                  </div>
                  <div className="settings-row">
                    <div><strong>会话数据库</strong><small>仅保存在此设备的应用数据目录</small></div>
                    <span className="security-state"><Icon name="check" size={14} /> 本地</span>
                  </div>
                </section>
                <section className="settings-card export-card">
                  <div><Icon name="archive" size={20} /><span><strong>导出加密备份</strong><small>创建包含设置和会话的便携备份</small></span></div>
                  <button disabled>即将支持</button>
                </section>
                <section className="settings-card danger-card">
                  <div className="danger-card-head">
                    <Icon name="trash" size={20} />
                    <span>
                      <strong>清除全部会话数据</strong>
                      <small>删除所有对话与消息，重新加密本地数据。不会清除已配置的供应商与模型。</small>
                    </span>
                  </div>
                  {clearError && <p className="danger-card-error">{clearError}</p>}
                  {clearConfirming ? (
                    <div className="danger-card-confirm">
                      <p>将永久删除全部会话，此操作无法撤销。确定继续吗？</p>
                      <div className="danger-card-actions">
                        <button
                          className="secondary-button"
                          disabled={clearing}
                          onClick={() => { setClearConfirming(false); setClearError('') }}
                        >
                          取消
                        </button>
                        <button
                          className="danger-button"
                          disabled={clearing}
                          onClick={() => void confirmClearData()}
                        >
                          {clearing ? '清除中…' : '确认清除'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      className="danger-button"
                      disabled={!onClearData}
                      onClick={() => setClearConfirming(true)}
                    >
                      <Icon name="trash" size={14} /> 清除全部会话数据
                    </button>
                  )}
                </section>
              </div>
            )}

            {activeSection === 'about' && (
              <div className="about-panel">
                <div className="about-mark"><Icon name="app" size={42} /></div>
                <h2>ChatBox Lite</h2>
                <p>简洁、私密的多模型桌面聊天客户端。</p>
                <span className="version-pill">Version 0.1.0</span>
                <div className="about-divider" />
                <small>Built with React, Electron & OpenRouter</small>
              </div>
            )}
          </div>

          <footer className="settings-footer">
            <span className={saveError ? 'settings-save-error' : ''}>
              {saveError || '更改将安全地保存在本机'}
            </span>
            <div>
              <button className="secondary-button" onClick={closeDialog}>取消</button>
              <button className="primary-button" disabled={saving || providersRequiringNewKey.length > 0} onClick={save}>
                {saving ? '保存中…' : '保存更改'}
              </button>
            </div>
          </footer>
        </div>
      </section>
    </div>
  )
}
