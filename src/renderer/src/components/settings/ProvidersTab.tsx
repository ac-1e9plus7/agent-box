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
        name: t("Custom provider"),
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
        name: t("provider.cliProxyLocalVariant"),
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
                    <span>{t("{value0} providers", { value0: providerDrafts.length })}</span>
                    <button onClick={addProvider}><Icon name="plus" size={15} />{t("Add")}</button>
                  </div>
                  <button className="cliproxy-preset-button" onClick={addCliProxyPreset}>
                    <span><Icon name="code" size={17} /></span>
                    <span><strong>{t("CLIProxyAPI local default")}</strong><small>{t("127.0.0.1:8317 · Key optional")}</small></span>
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
                        <span><strong>{provider.name}</strong><small>{provider.hasApiKey ? t("Key stored") : isProviderKeyOptional(provider) ? t("Local connection · Key optional") : t("Requires API key")}</small></span>
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
                        <div><h3>{selectedProvider.name}</h3><small>{selectedProvider.id === 'openrouter' ? t("Built-in provider") : selectedProvider.kind === 'cliproxy' ? t("Local compatible proxy") : t("Custom provider")}</small></div>
                      </div>
                      <span className="settings-value-note">{clearApiKeyIds.includes(selectedProvider.id) ? t("Key will be cleared") : selectedProvider.hasApiKey ? t("Key stored") : selectedProviderKeyOptional ? t("Key optional") : t("To be configured")}</span>
                    </div>
                    <div className="editor-form-grid single-column">
                      <label>
                        <FieldLabel>{t("Name")}</FieldLabel>
                        <input value={selectedProvider.name} onChange={(event) => updateProvider({ name: event.target.value })} />
                      </label>
                      <label>
                        <FieldLabel>{t("Provider type")}</FieldLabel>
                        <select value={selectedProvider.kind} onChange={(event) => updateProvider({ kind: event.target.value as ProviderConfig['kind'] })}>
                          <option value="openrouter">OpenRouter</option>
                          <option value="openai">{t("OpenAI-compatible")}</option>
                          <option value="anthropic">Anthropic</option>
                          <option value="cliproxy">{t("CLIProxyAPI (local)")}</option>
                          <option value="custom">{t("Custom")}</option>
                        </select>
                      </label>
                      <label>
                        <FieldLabel hint={t("Responses API is recommended for new integrations")}>{t("Default API format")}</FieldLabel>
                        <div className="provider-api-format-control">
                          <select
                            aria-describedby="legacy-chat-completions-hint"
                            title={selectedProvider.apiFormat === 'openai-chat-completions'
                              ? LEGACY_CHAT_COMPLETIONS_HINT
                              : t("The Responses API is recommended for new integrations.")}
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
                            <span>{t("Chat Completions API guidance")}</span>
                          </span>
                        </div>
                      </label>
                      <label>
                        <FieldLabel hint={selectedProvider.kind === 'cliproxy' ? t("CLIProxyAPI default local listening address") : t("Requests are sent to this URL")}>{t("Base URL")}</FieldLabel>
                        <input
                          className="mono-input"
                          placeholder={selectedProvider.kind === 'cliproxy' ? 'http://127.0.0.1:8317/v1' : 'https://openrouter.ai/api/v1'}
                          value={selectedProvider.baseUrl}
                          onChange={(event) => updateProvider({ baseUrl: event.target.value })}
                        />
                      </label>
                      <label>
                        <FieldLabel hint={selectedProviderKeyOptional ? t("If api-keys in config.yaml is empty, it can be left blank.") : selectedProvider.hasApiKey ? t("Saved encrypted; leave blank to remain unchanged") : t("Encrypted with OS-protected storage when saved")}>{t("API key")}</FieldLabel>
                        <div className="secret-input">
                          <Icon name="key" size={16} />
                          <input
                            autoComplete="off"
                            placeholder={clearApiKeyIds.includes(selectedProvider.id) ? t("The key will be cleared when you save; enter a new value to keep a key instead") : selectedProvider.hasApiKey ? '••••••••••••••••••••' : selectedProviderKeyOptional ? t("Optional: Fill in the key configured by CLIProxyAPI") : 'sk-or-v1-…'}
                            type={showApiKey ? 'text' : 'password'}
                            value={apiKeyInputs[selectedProvider.id] ?? ''}
                            onChange={(event) => {
                              const value = event.target.value
                              setApiKeyInputs((current) => ({ ...current, [selectedProvider.id]: value }))
                              if (value.trim()) setClearApiKeyIds((current) => current.filter((id) => id !== selectedProvider.id))
                            }}
                          />
                          <button type="button" onClick={() => setShowApiKey((current) => !current)}>{showApiKey ? t("Hide") : t("Show")}</button>
                        </div>
                        {selectedProvider.hasApiKey && (
                          <button
                            className={`clear-secret-button ${clearApiKeyIds.includes(selectedProvider.id) ? 'is-active' : ''}`}
                            type="button"
                            onClick={() => toggleClearApiKey(selectedProvider.id)}
                          >
                            <Icon name={clearApiKeyIds.includes(selectedProvider.id) ? 'refresh' : 'trash'} size={13} />
                            {clearApiKeyIds.includes(selectedProvider.id) ? t("Keep existing key") : t("Clear key when saving")}
                          </button>
                        )}
                        {selectedProviderNeedsNewKey && (
                          <span className="credential-warning">
                            <Icon name="info" size={13} />{t("The provider URL or type changed. For security, the saved API key will be cleared; enter it again.")}</span>
                        )}
                      </label>
                    </div>
                    <div className="provider-security-banner">
                      <Icon name="shield" size={18} />
                      <div><strong>{selectedProviderKeyOptional ? t("Local loopback connections can be used without an API key") : t("The key is never stored in persistent renderer state")}</strong><p>{selectedProviderKeyOptional ? t("If the api-keys of CLIProxyAPI are not configured, please keep it empty; it will still be securely encrypted when filled in.") : t("When saved, the key is sent securely to the main process and encrypted using OS-protected storage.")}</p></div>
                    </div>
                    {selectedProviderKeyOptional
                      && (!selectedProvider.hasApiKey || clearApiKeyIds.includes(selectedProvider.id))
                      && !(apiKeyInputs[selectedProvider.id] ?? '').trim() && (
                      <div className="cliproxy-network-warning">
                        <Icon name="info" size={17} />
                        <div><strong>{t("Restrict the server listen address when no key is configured")}</strong><p>{t("In CLIProxyAPI config.yaml, set host: \"127.0.0.1\". The default host: \"\" may allow access from the local network, and TLS is disabled by default.")}</p></div>
                      </div>
                    )}
                    <div className="provider-actions">
                      <button
                        className={`test-connection-button ${testState === 'success' ? 'is-success' : ''}`}
                        disabled={!onTestProvider || testState === 'testing' || selectedProviderNeedsNewKey || ((!selectedProvider.hasApiKey || clearApiKeyIds.includes(selectedProvider.id)) && !selectedProviderKeyOptional && !(apiKeyInputs[selectedProvider.id] ?? '').trim())}
                        onClick={testProvider}
                      >
                        {testState === 'testing' ? <><span className="button-spinner" />{t("Testing…")}</> :
                          testState === 'success' ? <><Icon name="check" size={15} />{t("Connection successful")}</> :
                            testState === 'failed' ? <><Icon name="info" size={15} />{t("Retry connection")}</> :
                              <><Icon name="refresh" size={15} />{t("Test current configuration")}</>}
                      </button>
                      {selectedProvider.id !== 'openrouter' && (
                        <button className="remove-provider-button" onClick={removeProvider}><Icon name="trash" size={15} />{t("Delete")}</button>
                      )}
                    </div>
                  </div>
                )}
              </div>
  )
}
