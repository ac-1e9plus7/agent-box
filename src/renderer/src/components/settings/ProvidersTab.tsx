import { useEffect, useMemo, useState } from 'react'
import type { Dispatch, JSX, SetStateAction } from 'react'
import type { ApiFormat, ModelConfig, ProviderConfig } from '../../types'
import { API_FORMAT_LABELS } from '../../types'
import {
  DEFAULT_NEW_PROVIDER_API_FORMAT,
  LEGACY_CHAT_COMPLETIONS_HINT,
  providerApiFormatOptionLabel,
} from '../../api-format-options'
import { t } from '../../../../shared/i18n'
import { Icon } from '../Icon'
import { FieldLabel } from './SettingsControls'

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

interface ProvidersTabProps {
  apiKeyInputs: Record<string, string>
  clearApiKeyIds: string[]
  onTestProvider?: (provider: ProviderConfig, apiKeyInput: string, clearApiKey: boolean) => Promise<boolean>
  providerDrafts: ProviderConfig[]
  providersRequiringNewKey: ProviderConfig[]
  setApiKeyInputs: Dispatch<SetStateAction<Record<string, string>>>
  setClearApiKeyIds: Dispatch<SetStateAction<string[]>>
  setModelDrafts: Dispatch<SetStateAction<ModelConfig[]>>
  setProviderDrafts: Dispatch<SetStateAction<ProviderConfig[]>>
}

export function ProvidersTab({
  apiKeyInputs,
  clearApiKeyIds,
  onTestProvider,
  providerDrafts,
  providersRequiringNewKey,
  setApiKeyInputs,
  setClearApiKeyIds,
  setModelDrafts,
  setProviderDrafts,
}: ProvidersTabProps): JSX.Element {
  const [selectedProviderId, setSelectedProviderId] = useState(providerDrafts[0]?.id ?? '')
  const [showApiKey, setShowApiKey] = useState(false)
  const [testState, setTestState] = useState<'idle' | 'testing' | 'success' | 'failed'>('idle')

  useEffect(() => {
    if (providerDrafts.some((provider) => provider.id === selectedProviderId)) return
    setSelectedProviderId(providerDrafts[0]?.id ?? '')
  }, [providerDrafts, selectedProviderId])

  const selectedProvider = useMemo(
    () => providerDrafts.find((provider) => provider.id === selectedProviderId),
    [providerDrafts, selectedProviderId],
  )
  const selectedProviderNeedsNewKey = providersRequiringNewKey.some((provider) => provider.id === selectedProviderId)
  const selectedProviderKeyOptional = selectedProvider ? isProviderKeyOptional(selectedProvider) : false

  const updateProvider = (patch: Partial<ProviderConfig>): void => {
    setProviderDrafts((current) => current.map((provider) => (
      provider.id === selectedProviderId ? { ...provider, ...patch } : provider
    )))
  }

  const addProvider = (): void => {
    const id = uniqueId('provider')
    setProviderDrafts((current) => [
      ...current,
      {
        id,
        name: t("自定义服务商"),
        kind: 'custom',
        baseUrl: 'https://api.example.com/v1',
        apiFormat: DEFAULT_NEW_PROVIDER_API_FORMAT,
        hasApiKey: false,
        apiKeyOptional: false,
        defaultHeaders: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
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
        name: t("CLIProxyAPI（本地）"),
        kind: 'cliproxy',
        baseUrl: 'http://127.0.0.1:8317/v1',
        apiFormat: 'openai-chat-completions',
        hasApiKey: false,
        apiKeyOptional: true,
        defaultHeaders: {},
        createdAt: now,
        updatedAt: now,
      },
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

  const testProvider = async (): Promise<void> => {
    if (!selectedProvider || !onTestProvider) return
    setTestState('testing')
    try {
      const success = await onTestProvider(
        selectedProvider,
        apiKeyInputs[selectedProvider.id] ?? '',
        clearApiKeyIds.includes(selectedProvider.id),
      )
      setTestState(success ? 'success' : 'failed')
    } catch {
      setTestState('failed')
    }
  }

  return (
              <div className="settings-split-view">
                <aside className="settings-list-panel">
                  <div className="settings-list-toolbar">
                    <span>{t("{value0} 个服务商", { value0: providerDrafts.length })}</span>
                    <button onClick={addProvider}><Icon name="plus" size={15} />{t("添加")}</button>
                  </div>
                  <button className="cliproxy-preset-button" onClick={addCliProxyPreset}>
                    <span><Icon name="code" size={17} /></span>
                    <span><strong>{t("CLIProxyAPI 本地预设")}</strong><small>{t("127.0.0.1:8317 · 密钥可选")}</small></span>
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
                        <span><strong>{provider.name}</strong><small>{provider.hasApiKey ? t("密钥已保存") : isProviderKeyOptional(provider) ? t("本机连接 · 密钥可选") : t("需要 API 密钥")}</small></span>
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
                        <div><h3>{selectedProvider.name}</h3><small>{selectedProvider.id === 'openrouter' ? t("内置服务商") : selectedProvider.kind === 'cliproxy' ? t("本机兼容代理") : t("自定义服务商")}</small></div>
                      </div>
                      <span className="settings-value-note">{clearApiKeyIds.includes(selectedProvider.id) ? t("密钥待清除") : selectedProvider.hasApiKey ? t("密钥已保存") : selectedProviderKeyOptional ? t("密钥可选") : t("待配置")}</span>
                    </div>
                    <div className="editor-form-grid single-column">
                      <label>
                        <FieldLabel>{t("名称")}</FieldLabel>
                        <input value={selectedProvider.name} onChange={(event) => updateProvider({ name: event.target.value })} />
                      </label>
                      <label>
                        <FieldLabel>{t("服务商类型")}</FieldLabel>
                        <select value={selectedProvider.kind} onChange={(event) => updateProvider({ kind: event.target.value as ProviderConfig['kind'] })}>
                          <option value="openrouter">OpenRouter</option>
                          <option value="openai">{t("OpenAI 兼容")}</option>
                          <option value="anthropic">Anthropic</option>
                          <option value="cliproxy">{t("CLIProxyAPI（本机）")}</option>
                          <option value="custom">{t("自定义")}</option>
                        </select>
                      </label>
                      <label>
                        <FieldLabel hint={t("新接入推荐 Responses")}>{t("默认 API 格式")}</FieldLabel>
                        <div className="provider-api-format-control">
                          <select
                            aria-describedby="legacy-chat-completions-hint"
                            title={selectedProvider.apiFormat === 'openai-chat-completions'
                              ? LEGACY_CHAT_COMPLETIONS_HINT
                              : t("Responses 是新接入的推荐格式。")}
                            value={selectedProvider.apiFormat}
                            onChange={(event) => updateProvider({ apiFormat: event.target.value as ApiFormat })}
                          >
                            {(Object.keys(API_FORMAT_LABELS) as ApiFormat[]).map((format) => (
                              <option
                                key={format}
                                title={format === 'openai-chat-completions' ? LEGACY_CHAT_COMPLETIONS_HINT : undefined}
                                value={format}
                              >
                                {providerApiFormatOptionLabel(format)}
                              </option>
                            ))}
                          </select>
                          <span
                            aria-label={LEGACY_CHAT_COMPLETIONS_HINT}
                            className="provider-api-format-hint"
                            id="legacy-chat-completions-hint"
                            tabIndex={0}
                            title={LEGACY_CHAT_COMPLETIONS_HINT}
                          >
                            <Icon name="info" size={13} />
                            <span>{t("旧版格式说明")}</span>
                          </span>
                        </div>
                      </label>
                      <label>
                        <FieldLabel hint={selectedProvider.kind === 'cliproxy' ? t("CLIProxyAPI 默认本机监听地址") : t("请求将发送到此地址")}>{t('provider.baseUrl')}</FieldLabel>
                        <input
                          className="mono-input"
                          placeholder={selectedProvider.kind === 'cliproxy' ? 'http://127.0.0.1:8317/v1' : 'https://openrouter.ai/api/v1'}
                          value={selectedProvider.baseUrl}
                          onChange={(event) => updateProvider({ baseUrl: event.target.value })}
                        />
                      </label>
                      <label>
                        <FieldLabel hint={selectedProviderKeyOptional ? t("config.yaml 的 api-keys 为空时可留空") : selectedProvider.hasApiKey ? t("已加密保存；留空则保持不变") : t("保存后将由系统安全加密")}>{t("API 密钥")}</FieldLabel>
                        <div className="secret-input">
                          <Icon name="key" size={16} />
                          <input
                            autoComplete="off"
                            placeholder={clearApiKeyIds.includes(selectedProvider.id) ? t("保存后将清除密钥；输入新值可取消") : selectedProvider.hasApiKey ? '••••••••••••••••••••' : selectedProviderKeyOptional ? t("可选：填写 CLIProxyAPI 配置的密钥") : 'sk-or-v1-…'}
                            type={showApiKey ? 'text' : 'password'}
                            value={apiKeyInputs[selectedProvider.id] ?? ''}
                            onChange={(event) => {
                              const value = event.target.value
                              setApiKeyInputs((current) => ({ ...current, [selectedProvider.id]: value }))
                              if (value.trim()) setClearApiKeyIds((current) => current.filter((id) => id !== selectedProvider.id))
                            }}
                          />
                          <button type="button" onClick={() => setShowApiKey((current) => !current)}>{showApiKey ? t("隐藏") : t("显示")}</button>
                        </div>
                        {selectedProvider.hasApiKey && (
                          <button
                            className={`clear-secret-button ${clearApiKeyIds.includes(selectedProvider.id) ? 'is-active' : ''}`}
                            type="button"
                            onClick={() => toggleClearApiKey(selectedProvider.id)}
                          >
                            <Icon name={clearApiKeyIds.includes(selectedProvider.id) ? 'refresh' : 'trash'} size={13} />
                            {clearApiKeyIds.includes(selectedProvider.id) ? t("保留原密钥") : t("保存时清除密钥")}
                          </button>
                        )}
                        {selectedProviderNeedsNewKey && (
                          <span className="credential-warning">
                            <Icon name="info" size={13} />{t("连接地址或服务商类型已改变。安全策略会清除旧密钥，请重新输入。")}</span>
                        )}
                      </label>
                    </div>
                    <div className="provider-security-banner">
                      <Icon name="shield" size={18} />
                      <div><strong>{selectedProviderKeyOptional ? t("本机回环连接可无密钥使用") : t("密钥不会进入 renderer 持久状态")}</strong><p>{selectedProviderKeyOptional ? t("若 CLIProxyAPI 的 api-keys 未配置，请保持为空；填写时仍会安全加密。") : t("保存时通过安全通道交给主进程，并使用系统密钥链派生的密钥加密。")}</p></div>
                    </div>
                    {selectedProviderKeyOptional
                      && (!selectedProvider.hasApiKey || clearApiKeyIds.includes(selectedProvider.id))
                      && !(apiKeyInputs[selectedProvider.id] ?? '').trim() && (
                      <div className="cliproxy-network-warning">
                        <Icon name="info" size={17} />
                        <div><strong>{t("无密钥时必须限制服务端监听地址")}</strong><p>{t('cliproxy.hostWarning')}</p></div>
                      </div>
                    )}
                    <div className="provider-actions">
                      <button
                        className={`test-connection-button ${testState === 'success' ? 'is-success' : ''}`}
                        disabled={!onTestProvider || testState === 'testing' || selectedProviderNeedsNewKey || ((!selectedProvider.hasApiKey || clearApiKeyIds.includes(selectedProvider.id)) && !selectedProviderKeyOptional && !(apiKeyInputs[selectedProvider.id] ?? '').trim())}
                        onClick={testProvider}
                      >
                        {testState === 'testing' ? <><span className="button-spinner" />{t("测试中…")}</> :
                          testState === 'success' ? <><Icon name="check" size={15} />{t("连接成功")}</> :
                            testState === 'failed' ? <><Icon name="info" size={15} />{t("重试连接")}</> :
                              <><Icon name="refresh" size={15} />{t("测试当前配置")}</>}
                      </button>
                      {selectedProvider.id !== 'openrouter' && (
                        <button className="remove-provider-button" onClick={removeProvider}><Icon name="trash" size={15} />{t("删除")}</button>
                      )}
                    </div>
                  </div>
                )}
              </div>
  )
}
