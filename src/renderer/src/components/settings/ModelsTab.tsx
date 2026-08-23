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
        name: t("新模型"),
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
      setActionError(error instanceof Error ? error.message : t("无法获取远程模型列表。"))
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
                    <span>{t("{value0} 个模型", { value0: modelDrafts.length })}</span>
                    <div>
                      <button disabled={!onDiscoverModels || discovering} onClick={() => void discoverModels()}>
                        {discovering ? <span className="button-spinner" /> : <Icon name="refresh" size={14} />}{t("获取")}</button>
                      <button onClick={addModel}><Icon name="plus" size={15} />{t("添加")}</button>
                    </div>
                  </div>
                  {remoteModels && (
                    <div className="remote-model-picker">
                      <header><strong>{t("选择远程模型")}</strong><button aria-label={t("关闭模型列表")} onClick={() => setRemoteModels(null)}><Icon name="close" size={14} /></button></header>
                      <div>
                        {remoteModels.slice(0, 100).map((remoteModel) => (
                          <button key={remoteModel.id} onClick={() => addDiscoveredModel(remoteModel)}>
                            <span><strong>{remoteModel.name || remoteModel.id}</strong><small>{remoteModel.id}</small></span>
                            <Icon name="plus" size={14} />
                          </button>
                        ))}
                        {remoteModels.length === 0 && <p>{t("服务商没有返回可用模型。")}</p>}
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
                          <span><strong>{model.name || t("未命名模型")}</strong><small>{provider?.name ?? t("未选择服务商")}</small></span>
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
                        <div><h3>{selectedModel.name || t("未命名模型")}</h3><small>{selectedModel.remoteId || t("填写模型标识")}</small></div>
                      </div>
                      <span className="settings-value-note">{t("已配置")}</span>
                    </div>

                    <div className="editor-form-grid">
                      <label>
                        <FieldLabel>{t("显示名称")}</FieldLabel>
                        <input value={selectedModel.name} onChange={(event) => updateModel({ name: event.target.value })} />
                      </label>
                      <label>
                        <FieldLabel hint={t("OpenRouter 模型 slug")}>{t("模型 ID")}</FieldLabel>
                        <input
                          className="mono-input"
                          placeholder="anthropic/claude-sonnet-4"
                          value={selectedModel.remoteId}
                          onChange={(event) => updateModel({ remoteId: event.target.value })}
                        />
                      </label>
                      <label>
                        <FieldLabel>{t("服务商")}</FieldLabel>
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
                        <FieldLabel hint={t("按模型或端点指定")}>{t("API 格式")}</FieldLabel>
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
                        <FieldLabel hint={t("± 按钮以 64K 为步长")}>{t("上下文窗口")}</FieldLabel>
                        <TokenStepper
                          ariaLabel={t("上下文窗口")}
                          maximum={100_000_000}
                          minimum={1_024}
                          value={selectedModel.contextWindow}
                          onChange={(contextWindow) => updateModel({ contextWindow })}
                        />
                      </div>
                      <div className="token-field">
                        <FieldLabel hint={t("± 按钮以 64K 为步长")}>{t("最大输出 Token")}</FieldLabel>
                        <TokenStepper
                          ariaLabel={t("最大输出 Token")}
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
                        <span><strong>{t("远程接口未返回完整模型能力")}</strong><small>{t("当前缺失项使用通用默认值。保存前请手工校准上下文窗口、最大输出 Token 和思考支持。")}</small></span>
                        <button onClick={() => setModelsNeedingCalibration((current) => current.filter((id) => id !== selectedModel.id))}>{t("知道了")}</button>
                      </div>
                    )}

                    {selectedModelProvider?.kind === 'openrouter' && (
                      <section className="routing-card">
                        <div className="routing-heading">
                          <span className="entity-icon provider-icon"><Icon name="globe" size={16} /></span>
                          <div>
                            <strong>{t("OpenRouter 上游供应商")}</strong>
                            <small>{t("限定该模型实际由哪些 provider 提供推理")}</small>
                          </div>
                        </div>
                        <label className="routing-only-field">
                          <FieldLabel hint={t("逗号分隔；留空为自动选择")}>{t("指定供应商 slug")}</FieldLabel>
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
                            <FieldLabel>{t("排序偏好")}</FieldLabel>
                            <select
                              value={selectedModel.providerRouting?.sort ?? ''}
                              onChange={(event) => updateModel({
                                providerRouting: {
                                  ...selectedModel.providerRouting,
                                  sort: (event.target.value || undefined) as 'price' | 'throughput' | 'latency' | undefined
                                }
                              })}
                            >
                              <option value="">{t("OpenRouter 自动")}</option>
                              <option value="price">{t("价格优先")}</option>
                              <option value="latency">{t("低延迟优先")}</option>
                              <option value="throughput">{t("吞吐优先")}</option>
                            </select>
                          </label>
                          <label>
                            <FieldLabel>{t("数据收集策略")}</FieldLabel>
                            <select
                              value={selectedModel.providerRouting?.dataCollection ?? 'deny'}
                              onChange={(event) => updateModel({
                                providerRouting: {
                                  ...selectedModel.providerRouting,
                                  dataCollection: event.target.value as 'allow' | 'deny'
                                }
                              })}
                            >
                              <option value="allow">{t("允许")}</option>
                              <option value="deny">{t("禁止")}</option>
                            </select>
                          </label>
                        </div>
                        <div className="routing-toggles">
                          <div><span><strong>{t("允许回退")}</strong><small>{t("首选供应商不可用时切换到其他供应商")}</small></span><SettingsToggle
                            checked={selectedModel.providerRouting?.allowFallbacks ?? true}
                            label={t("允许供应商回退")}
                            onChange={(allowFallbacks) => updateModel({
                              providerRouting: { ...selectedModel.providerRouting, allowFallbacks }
                            })}
                          /></div>
                          <div><span><strong>{t("仅使用零数据保留端点")}</strong><small>{t("要求上游声明 ZDR 支持")}</small></span><SettingsToggle
                            checked={selectedModel.providerRouting?.zdr ?? true}
                            label={t("仅使用 ZDR 端点")}
                            onChange={(zdr) => updateModel({
                              providerRouting: { ...selectedModel.providerRouting, zdr }
                            })}
                          /></div>
                        </div>
                      </section>
                    )}

                    {selectedModelApiFormat === 'anthropic-messages' && (
                      <div className="anthropic-thinking-card">
                        <div><Icon name="brain" size={18} /><span><strong>{t("Anthropic 思考协议")}</strong><small>{t("根据 Claude 版本选择兼容模式")}</small></span></div>
                        <select
                          value={selectedModel.anthropicThinkingMode ?? 'adaptive'}
                          onChange={(event) => updateModel({ anthropicThinkingMode: event.target.value as 'adaptive' | 'manual' })}
                        >
                          <option value="adaptive">{t('anthropic.thinking.adaptive')}</option>
                          <option value="manual">{t("固定预算（Claude 4.5 及更早）")}</option>
                        </select>
                      </div>
                    )}

                    {selectedModelWebSearchAvailable && (
                      <div className="model-capability-card web-search-capability-card">
                        <div>
                          <Icon name="globe" size={18} />
                          <span>
                            <strong>{t("新会话默认联网模式")}</strong>
                            <small>{t("仅 OpenRouter 连接可用；旧会话保持关闭")}</small>
                          </span>
                        </div>
                        <select
                          aria-label={t("新会话默认联网模式")}
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
                      <div><Icon name="brain" size={18} /><span><strong>{t("思考模式")}</strong><small>{t("允许在聊天时开启或关闭模型推理")}</small></span></div>
                      <SettingsToggle
                        checked={selectedModel.supportsReasoning}
                        label={t("支持思考模式")}
                        onChange={(supportsReasoning) => updateModel({
                          supportsReasoning,
                          defaultReasoningEnabled: supportsReasoning ? selectedModel.defaultReasoningEnabled : false
                        })}
                      />
                    </div>
                    <div className="model-capability-card nested-capability">
                      <div><span><strong>{t("仅新会话默认开启")}</strong><small>{t("只影响之后新建的会话，不会修改已有会话")}</small></span></div>
                      <SettingsToggle
                        checked={selectedModel.defaultReasoningEnabled}
                        disabled={!selectedModel.supportsReasoning}
                        label={t("新会话默认开启思考")}
                        onChange={(defaultReasoningEnabled) => updateModel({ defaultReasoningEnabled })}
                      />
                    </div>
                    <div className="model-capability-card nested-capability">
                      <div><span><strong>{t("默认思考强度")}</strong><small>{t("该模型开启思考时使用的 effort")}</small></span></div>
                      <select
                        aria-label={t("模型默认思考强度")}
                        disabled={!selectedModel.supportsReasoning}
                        value={selectedModel.defaultReasoningEffort}
                        onChange={(event) => updateModel({
                          defaultReasoningEffort: event.target.value as ModelConfig['defaultReasoningEffort']
                        })}
                      >
                        <option value="minimal">{t("极简")}</option>
                        <option value="low">{t("低")}</option>
                        <option value="medium">{t("中")}</option>
                        <option value="high">{t("高")}</option>
                        <option value="xhigh">{t("很高")}</option>
                        <option value="max">{t("最高")}</option>
                      </select>
                    </div>

                    <div className="danger-row">
                      <button disabled={modelDrafts.length <= 1} onClick={removeModel}><Icon name="trash" size={15} />{t("删除模型")}</button>
                    </div>
                  </div>
                )}
              </div>
    </>
  )
}
