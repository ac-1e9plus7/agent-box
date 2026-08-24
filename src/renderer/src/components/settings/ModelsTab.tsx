import { useEffect, useMemo, useState } from 'react'
import type { Dispatch, JSX, SetStateAction } from 'react'
import type { ProviderRouting, RemoteModel } from '../../../../shared/types'
import type { ApiFormat, AppPreferences, ModelConfig, ProviderConfig, WebSearchMode } from '../../types'
import { API_FORMAT_LABELS } from '../../types'
import { isWebSearchAvailable, WEB_SEARCH_MODE_LABELS } from '../../web-search'
import { t } from '../../../../shared/i18n'
import { Icon } from '../Icon'
import { FieldLabel, SettingsToggle, TokenStepper } from './SettingsControls'

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function secureDefaultRouting(_providerId: string): ProviderRouting {
  return { dataCollection: 'deny', zdr: true }
}

interface ModelsTabProps {
  modelDrafts: ModelConfig[]
  onDiscoverModels?: (providerId: string) => Promise<RemoteModel[]>
  preferenceDraft: AppPreferences
  providerDrafts: ProviderConfig[]
  setModelDrafts: Dispatch<SetStateAction<ModelConfig[]>>
}

export function ModelsTab({
  modelDrafts,
  onDiscoverModels,
  preferenceDraft,
  providerDrafts,
  setModelDrafts,
}: ModelsTabProps): JSX.Element {
  const [selectedModelId, setSelectedModelId] = useState(modelDrafts[0]?.id ?? '')
  const [discovering, setDiscovering] = useState(false)
  const [remoteModels, setRemoteModels] = useState<RemoteModel[] | null>(null)
  const [modelsNeedingCalibration, setModelsNeedingCalibration] = useState<string[]>([])
  const [actionError, setActionError] = useState('')

  useEffect(() => {
    if (modelDrafts.some((model) => model.id === selectedModelId)) return
    setSelectedModelId(modelDrafts[0]?.id ?? '')
  }, [modelDrafts, selectedModelId])

  const selectedModel = useMemo(
    () => modelDrafts.find((model) => model.id === selectedModelId),
    [modelDrafts, selectedModelId],
  )
  const selectedModelProvider = useMemo(
    () => providerDrafts.find((provider) => provider.id === selectedModel?.providerId),
    [providerDrafts, selectedModel?.providerId],
  )
  const selectedModelApiFormat = selectedModel?.apiFormat ?? selectedModelProvider?.apiFormat
  const selectedModelWebSearchAvailable = isWebSearchAvailable(selectedModel, selectedModelProvider)

  const updateModel = (patch: Partial<ModelConfig>): void => {
    setModelDrafts((current) => current.map((model) => (
      model.id === selectedModelId ? { ...model, ...patch } : model
    )))
  }

  const addModel = (): void => {
    const id = uniqueId('model')
    setModelDrafts((current) => [
      ...current,
      {
        id,
        name: t("New model"),
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
        updatedAt: new Date().toISOString(),
      },
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
    setActionError('')
    try {
      setRemoteModels(await onDiscoverModels(providerId))
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("Could not retrieve the remote model list."))
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
        updatedAt: now,
      },
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

  return (
    <>
      {actionError && <p className="settings-save-error" role="alert">{actionError}</p>}
              <div className="settings-split-view">
                <aside className="settings-list-panel">
                  <div className="settings-list-toolbar">
                    <span>{t("{value0} models", { value0: modelDrafts.length })}</span>
                    <div>
                      <button disabled={!onDiscoverModels || discovering} onClick={() => void discoverModels()}>
                        {discovering ? <span className="button-spinner" /> : <Icon name="refresh" size={14} />}{t("Fetch")}</button>
                      <button onClick={addModel}><Icon name="plus" size={15} />{t("Add")}</button>
                    </div>
                  </div>
                  {remoteModels && (
                    <div className="remote-model-picker">
                      <header><strong>{t("Select remote model")}</strong><button aria-label={t("Close model list")} onClick={() => setRemoteModels(null)}><Icon name="close" size={14} /></button></header>
                      <div>
                        {remoteModels.slice(0, 100).map((remoteModel) => (
                          <button key={remoteModel.id} onClick={() => addDiscoveredModel(remoteModel)}>
                            <span><strong>{remoteModel.name || remoteModel.id}</strong><small>{remoteModel.id}</small></span>
                            <Icon name="plus" size={14} />
                          </button>
                        ))}
                        {remoteModels.length === 0 && <p>{t("The provider returned no available models.")}</p>}
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
                          <span><strong>{model.name || t("Unnamed model")}</strong><small>{provider?.name ?? t("No provider selected")}</small></span>
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
                        <div><h3>{selectedModel.name || t("Unnamed model")}</h3><small>{selectedModel.remoteId || t("Fill in the model ID")}</small></div>
                      </div>
                      <span className="settings-value-note">{t("Configured")}</span>
                    </div>

                    <div className="editor-form-grid">
                      <label>
                        <FieldLabel>{t("Display name")}</FieldLabel>
                        <input value={selectedModel.name} onChange={(event) => updateModel({ name: event.target.value })} />
                      </label>
                      <label>
                        <FieldLabel hint={t("OpenRouter model slug")}>{t("Model ID")}</FieldLabel>
                        <input
                          className="mono-input"
                          placeholder="anthropic/claude-sonnet-4"
                          value={selectedModel.remoteId}
                          onChange={(event) => updateModel({ remoteId: event.target.value })}
                        />
                      </label>
                      <label>
                        <FieldLabel>{t("Provider")}</FieldLabel>
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
                        <FieldLabel hint={t("Specify by model or endpoint")}>{t("API format")}</FieldLabel>
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
                        <FieldLabel hint={t("± buttons adjust in 64K increments")}>{t("Context window")}</FieldLabel>
                        <TokenStepper
                          ariaLabel={t("Context window")}
                          maximum={100_000_000}
                          minimum={1_024}
                          value={selectedModel.contextWindow}
                          onChange={(contextWindow) => updateModel({ contextWindow })}
                        />
                      </div>
                      <div className="token-field">
                        <FieldLabel hint={t("± buttons adjust in 64K increments")}>{t("Maximum output tokens")}</FieldLabel>
                        <TokenStepper
                          ariaLabel={t("Maximum output tokens")}
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
                        <span><strong>{t("Remote interface does not return full model capabilities")}</strong><small>{t("Missing capabilities use general defaults. Before saving, verify the context window, maximum output tokens, and reasoning support.")}</small></span>
                        <button onClick={() => setModelsNeedingCalibration((current) => current.filter((id) => id !== selectedModel.id))}>{t("Got it")}</button>
                      </div>
                    )}

                    {selectedModelProvider?.kind === 'openrouter' && (
                      <section className="routing-card">
                        <div className="routing-heading">
                          <span className="entity-icon provider-icon"><Icon name="globe" size={16} /></span>
                          <div>
                            <strong>{t("OpenRouter providers")}</strong>
                            <small>{t("Choose which OpenRouter providers may serve this model")}</small>
                          </div>
                        </div>
                        <label className="routing-only-field">
                          <FieldLabel hint={t("Comma-separated; leave blank to let OpenRouter choose")}>{t("Allowed provider slugs")}</FieldLabel>
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
                            <FieldLabel>{t("Sort providers by")}</FieldLabel>
                            <select
                              value={selectedModel.providerRouting?.sort ?? ''}
                              onChange={(event) => updateModel({
                                providerRouting: {
                                  ...selectedModel.providerRouting,
                                  sort: (event.target.value || undefined) as 'price' | 'throughput' | 'latency' | undefined
                                }
                              })}
                            >
                              <option value="">{t("OpenRouter default")}</option>
                              <option value="price">{t("Lowest price")}</option>
                              <option value="latency">{t("Lowest latency")}</option>
                              <option value="throughput">{t("Highest throughput")}</option>
                            </select>
                          </label>
                          <label>
                            <FieldLabel>{t("Data collection policy")}</FieldLabel>
                            <select
                              value={selectedModel.providerRouting?.dataCollection ?? 'deny'}
                              onChange={(event) => updateModel({
                                providerRouting: {
                                  ...selectedModel.providerRouting,
                                  dataCollection: event.target.value as 'allow' | 'deny'
                                }
                              })}
                            >
                              <option value="allow">{t("Allow")}</option>
                              <option value="deny">{t("modelPermissions.denyOption")}</option>
                            </select>
                          </label>
                        </div>
                        <div className="routing-toggles">
                          <div><span><strong>{t("Allow fallbacks")}</strong><small>{t("Switch to another provider when your preferred provider is unavailable")}</small></span><SettingsToggle
                            checked={selectedModel.providerRouting?.allowFallbacks ?? true}
                            label={t("Allow provider fallbacks")}
                            onChange={(allowFallbacks) => updateModel({
                              providerRouting: { ...selectedModel.providerRouting, allowFallbacks }
                            })}
                          /></div>
                          <div><span><strong>{t("Zero Data Retention (ZDR) endpoints only")}</strong><small>{t("Require Zero Data Retention (ZDR) support")}</small></span><SettingsToggle
                            checked={selectedModel.providerRouting?.zdr ?? true}
                            label={t("Use ZDR endpoints only")}
                            onChange={(zdr) => updateModel({
                              providerRouting: { ...selectedModel.providerRouting, zdr }
                            })}
                          /></div>
                        </div>
                      </section>
                    )}

                    {selectedModelApiFormat === 'anthropic-messages' && (
                      <div className="anthropic-thinking-card">
                        <div><Icon name="brain" size={18} /><span><strong>{t("Anthropic thinking mode")}</strong><small>{t("Choose the mode supported by this Claude model")}</small></span></div>
                        <select
                          value={selectedModel.anthropicThinkingMode ?? 'adaptive'}
                          onChange={(event) => updateModel({ anthropicThinkingMode: event.target.value as 'adaptive' | 'manual' })}
                        >
                          <option value="adaptive">{t("Adaptive thinking (Claude 4.6+)")}</option>
                          <option value="manual">{t("Manual extended thinking (Claude 4.5 and earlier; deprecated on 4.6)")}</option>
                        </select>
                      </div>
                    )}

                    {selectedModelWebSearchAvailable && (
                      <div className="model-capability-card web-search-capability-card">
                        <div>
                          <Icon name="globe" size={18} />
                          <span>
                            <strong>{t("Default web search mode for new conversations")}</strong>
                            <small>{t("Available only for OpenRouter connections; existing conversations remain off")}</small>
                          </span>
                        </div>
                        <select
                          aria-label={t("Default web search mode for new conversations")}
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
                      <div><Icon name="brain" size={18} /><span><strong>{t("Reasoning")}</strong><small>{t("Allow reasoning to be toggled for this model")}</small></span></div>
                      <SettingsToggle
                        checked={selectedModel.supportsReasoning}
                        label={t("Supports reasoning")}
                        onChange={(supportsReasoning) => updateModel({
                          supportsReasoning,
                          defaultReasoningEnabled: supportsReasoning ? selectedModel.defaultReasoningEnabled : false
                        })}
                      />
                    </div>
                    <div className="model-capability-card nested-capability">
                      <div><span><strong>{t("Enable by default only for new conversations")}</strong><small>{t("Affects only newly created conversations; existing conversations are unchanged")}</small></span></div>
                      <SettingsToggle
                        checked={selectedModel.defaultReasoningEnabled}
                        disabled={!selectedModel.supportsReasoning}
                        label={t("Enable reasoning by default for new conversations")}
                        onChange={(defaultReasoningEnabled) => updateModel({ defaultReasoningEnabled })}
                      />
                    </div>
                    <div className="model-capability-card nested-capability">
                      <div><span><strong>{t("Default reasoning effort")}</strong><small>{t("Reasoning effort used when reasoning is enabled for this model")}</small></span></div>
                      <select
                        aria-label={t("Default model reasoning effort")}
                        disabled={!selectedModel.supportsReasoning}
                        value={selectedModel.defaultReasoningEffort}
                        onChange={(event) => updateModel({
                          defaultReasoningEffort: event.target.value as ModelConfig['defaultReasoningEffort']
                        })}
                      >
                        <option value="minimal">{t("Minimal")}</option>
                        <option value="low">{t("Low")}</option>
                        <option value="medium">{t("Medium")}</option>
                        <option value="high">{t("High")}</option>
                        <option value="xhigh">{t("Extra high (xhigh)")}</option>
                        <option value="max">{t("Maximum (max)")}</option>
                      </select>
                    </div>

                    <div className="danger-row">
                      <button disabled={modelDrafts.length <= 1} onClick={removeModel}><Icon name="trash" size={15} />{t("Delete model")}</button>
                    </div>
                  </div>
                )}
              </div>
    </>
  )
}
