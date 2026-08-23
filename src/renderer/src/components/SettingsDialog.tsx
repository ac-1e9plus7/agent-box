import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import type {
  AppPreferences,
  ModelConfig,
  ProviderConfig,
  SettingsSection
} from '../types'
import type { BackupMode, CondaEnvironmentListResult, DeveloperRuntimeKind, DeveloperRuntimeSettings, ExportBackupInput, ExportBackupResult, IntegratedTerminalShellConfig, McpServerConfig, McpServerInput, McpServerTestResult, McpToolDefinition, RemoteModel, RuntimeTestResult, Skill, SkillInput, TerminalShellTestResult } from '../../../shared/types'
import { validateAvatarSourceFile } from '../avatar-helper'
import { AvatarCropDialog } from './AvatarCropDialog'
import { Icon } from './Icon'
import { t } from '../../../shared/i18n'
import { SkillsTab } from './settings/SkillsTab'
import { McpTab } from './settings/McpTab'
import { AboutTab } from './settings/AboutTab'
import { SecurityTab } from './settings/SecurityTab'
import { ModelsTab } from './settings/ModelsTab'
import { ProvidersTab } from './settings/ProvidersTab'
import { GeneralTab } from './settings/GeneralTab'
import { RuntimesTab } from './settings/RuntimesTab'

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
  skills?: Skill[]
  mcpServers?: McpServerConfig[]
  onClose: () => void
  onClearData?: () => Promise<void>
  onExportBackup?: (input: ExportBackupInput) => Promise<ExportBackupResult>
  onDiscoverModels?: (providerId: string) => Promise<RemoteModel[]>
  onSave: (payload: SettingsSavePayload) => void | Promise<void>
  onTestProvider?: (provider: ProviderConfig, apiKeyInput: string, clearApiKey: boolean) => Promise<boolean>
  onUpsertSkill?: (input: SkillInput) => Promise<Skill>
  onRemoveSkill?: (id: string) => Promise<void>
  onToggleSkill?: (id: string, enabled: boolean) => Promise<Skill>
  onResetDefaultSkills?: () => Promise<Skill[]>
  onUpsertMcpServer?: (input: McpServerInput) => Promise<McpServerConfig>
  onRemoveMcpServer?: (id: string) => Promise<void>
  onToggleMcpServer?: (id: string, enabled: boolean) => Promise<McpServerConfig>
  onTestMcpServer?: (input: McpServerInput) => Promise<McpServerTestResult>
  onListMcpTools?: (serverId?: string) => Promise<McpToolDefinition[]>
  onTestTerminalShell?: (config: IntegratedTerminalShellConfig) => Promise<TerminalShellTestResult>
  onSelectDirectory?: (initialPath?: string) => Promise<string | undefined>
  onTestRuntime?: (kind: DeveloperRuntimeKind, settings: DeveloperRuntimeSettings, workingDirectory?: string) => Promise<RuntimeTestResult>
  onListCondaEnvironments?: (condaExecutable: string) => Promise<CondaEnvironmentListResult>
}

const settingsNav: Array<{ id: SettingsSection; label: string; icon: Parameters<typeof Icon>[0]['name'] }> = [
  { id: 'general', label: t("通用"), icon: 'settings' },
  { id: 'runtimes', label: t("开发运行时"), icon: 'code' },
  { id: 'skills', label: t("Agent 技能"), icon: 'bot' },
  { id: 'mcp', label: t("MCP 外部工具"), icon: 'tool' },
  { id: 'models', label: t("模型"), icon: 'sparkles' },
  { id: 'providers', label: t("服务商"), icon: 'globe' },
  { id: 'security', label: t("数据与安全"), icon: 'shield' },
  { id: 'about', label: t("关于"), icon: 'info' }
]

export function SettingsDialog({
  initialSection,
  models,
  open,
  preferences,
  providers,
  skills = [],
  mcpServers = [],
  onClose,
  onClearData,
  onExportBackup,
  onDiscoverModels,
  onSave,
  onTestProvider,
  onUpsertSkill,
  onRemoveSkill,
  onToggleSkill,
  onResetDefaultSkills,
  onUpsertMcpServer,
  onRemoveMcpServer,
  onToggleMcpServer,
  onTestMcpServer,
  onListMcpTools,
  onTestTerminalShell,
  onSelectDirectory,
  onTestRuntime,
  onListCondaEnvironments,
}: SettingsDialogProps): JSX.Element | null {
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection)
  const [modelDrafts, setModelDrafts] = useState<ModelConfig[]>(models)
  const [providerDrafts, setProviderDrafts] = useState<ProviderConfig[]>(providers)
  const [preferenceDraft, setPreferenceDraft] = useState<AppPreferences>(preferences)
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({})
  const [clearApiKeyIds, setClearApiKeyIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [clearConfirming, setClearConfirming] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [clearError, setClearError] = useState('')
  const [backupConfiguring, setBackupConfiguring] = useState(false)
  const [backupMode, setBackupMode] = useState<BackupMode>('shallow')
  const [backupPassword, setBackupPassword] = useState('')
  const [backupPasswordConfirmation, setBackupPasswordConfirmation] = useState('')
  const [backupExporting, setBackupExporting] = useState(false)
  const [backupError, setBackupError] = useState('')
  const [backupResult, setBackupResult] = useState<ExportBackupResult | null>(null)
  const [terminalShellTest, setTerminalShellTest] = useState<TerminalShellTestResult | null>(null)
  const [testingTerminalShell, setTestingTerminalShell] = useState(false)
  const [avatarCropSource, setAvatarCropSource] = useState<string | null>(null)
  const [avatarInputError, setAvatarInputError] = useState('')


  useEffect(() => {
    setTerminalShellTest(null)
  }, [
    preferenceDraft.integratedTerminalShell.mode,
    preferenceDraft.integratedTerminalShell.executable,
    preferenceDraft.integratedTerminalShell.args.join('\0'),
  ])




  const confirmClearData = async (): Promise<void> => {
    if (!onClearData) return
    setClearing(true)
    setClearError('')
    try {
      await onClearData()
      setClearConfirming(false)
      closeDialog()
    } catch (error) {
      setClearError(error instanceof Error ? error.message : t("清除失败，请重试。"))
    } finally {
      setClearing(false)
    }
  }

  const exportBackup = async (): Promise<void> => {
    if (!onExportBackup || backupExporting) return
    if (backupPassword !== backupPasswordConfirmation) {
      setBackupError(t("两次输入的备份密码不一致。"))
      return
    }

    setBackupExporting(true)
    setBackupError('')
    setBackupResult(null)
    try {
      const result = await onExportBackup({
        mode: backupMode,
        ...(backupPassword ? { password: backupPassword } : {}),
      })
      setBackupPassword('')
      setBackupPasswordConfirmation('')
      if (!result.canceled) {
        setBackupResult(result)
      }
    } catch (error) {
      setBackupError(error instanceof Error ? error.message : t("导出备份失败，请重试。"))
    } finally {
      setBackupExporting(false)
    }
  }

  const closeDialog = useCallback((): void => {
    if (backupExporting) return
    setApiKeyInputs({})
    setClearApiKeyIds([])
    setSaveError('')
    setBackupConfiguring(false)
    setBackupPassword('')
    setBackupPasswordConfirmation('')
    setBackupError('')
    setBackupResult(null)
    setAvatarCropSource(null)
    setAvatarInputError('')
    onClose()
  }, [backupExporting, onClose])

  useEffect(() => {
    if (!open) return
    setActiveSection(initialSection)
    setModelDrafts(models.map((model) => ({ ...model })))
    setProviderDrafts(providers.map((provider) => ({ ...provider })))
    setPreferenceDraft({ ...preferences })
    setApiKeyInputs({})
    setClearApiKeyIds([])
    setSaveError('')
    setBackupConfiguring(false)
    setBackupMode('shallow')
    setBackupPassword('')
    setBackupPasswordConfirmation('')
    setBackupExporting(false)
    setBackupError('')
    setBackupResult(null)
    setAvatarCropSource(null)
    setAvatarInputError('')
  }, [initialSection, models, open, preferences, providers])

  useEffect(() => () => {
    if (avatarCropSource) URL.revokeObjectURL(avatarCropSource)
  }, [avatarCropSource])

  const selectAvatarFile = (file: File | undefined): void => {
    if (!file) return
    try {
      validateAvatarSourceFile(file)
      setAvatarInputError('')
      setAvatarCropSource(URL.createObjectURL(file))
    } catch (error) {
      setAvatarInputError(error instanceof Error ? error.message : t("无法读取头像图片。"))
    }
  }


  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (avatarCropSource) setAvatarCropSource(null)
      else closeDialog()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [avatarCropSource, closeDialog, open])

  const providersRequiringNewKey = useMemo(() => providerDrafts.filter((provider) => {
    const original = providers.find((item) => item.id === provider.id)
    if (!original?.hasApiKey) return false
    const credentialScopeChanged = original.baseUrl !== provider.baseUrl || original.kind !== provider.kind
    return credentialScopeChanged
      && !(apiKeyInputs[provider.id] ?? '').trim()
      && !clearApiKeyIds.includes(provider.id)
  }), [apiKeyInputs, clearApiKeyIds, providerDrafts, providers])

  if (!open) return null


  const save = async (): Promise<void> => {
    if (providersRequiringNewKey.length > 0) {
      setSaveError(t("“{value0}”的连接地址或类型已更改，请重新输入 API 密钥。", { value0: providersRequiringNewKey[0]?.name ?? t("服务商") }))
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
      setSaveError(error instanceof Error ? error.message : t("保存失败，请检查配置后重试。"))
    } finally {
      setSaving(false)
    }
  }

  const testTerminalShell = async (): Promise<void> => {
    if (!onTestTerminalShell) return
    setTestingTerminalShell(true)
    setTerminalShellTest(null)
    try {
      setTerminalShellTest(await onTestTerminalShell(preferenceDraft.integratedTerminalShell))
    } catch (error) {
      setTerminalShellTest({
        ok: false,
        platform: 'unknown',
        latencyMs: 0,
        message: error instanceof Error ? error.message : t("Shell 测试失败"),
      })
    } finally {
      setTestingTerminalShell(false)
    }
  }

  const chooseDirectory = async (current?: string): Promise<string | undefined> => {
    return onSelectDirectory ? onSelectDirectory(current || undefined) : undefined
  }



  const backupProtectionEnabled = backupResult?.encrypted ?? Boolean(backupPassword)

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) closeDialog()
    }}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-label={t("设置")}>
        <aside className="settings-sidebar">
          <div className="settings-brand">
            <span className="brand-mark"><Icon name="app" size={21} /></span>
            <span>AgentBox</span>
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
            <span><strong>{t("隐私优先")}</strong><small>{t("密钥与数据仅存于本机")}</small></span>
          </div>
        </aside>

        <div className="settings-main">
          <header className="settings-header">
            <div>
              <h2>{settingsNav.find((item) => item.id === activeSection)?.label}</h2>
              <p>{activeSection === 'general' && t("调整 AgentBox 的使用偏好")}</p>
              <p>{activeSection === 'runtimes' && t("配置项目默认 JDK、Go、PHP 与 Python 环境")}</p>
              <p>{activeSection === 'skills' && t("管理、安装与自定义 Agent 智能体专业技能")}</p>
              <p>{activeSection === 'mcp' && t("连接与管理 Model Context Protocol (MCP) 外部工具服务")}</p>
              <p>{activeSection === 'models' && t("配置模型能力、上下文窗口与请求格式")}</p>
              <p>{activeSection === 'providers' && t("管理 API 端点与访问密钥")}</p>
              <p>{activeSection === 'security' && t("了解本地加密与系统安全存储")}</p>
              <p>{activeSection === 'about' && t("关于 AgentBox 与系统信息")}</p>
            </div>
            <button className="icon-button" aria-label={t("关闭设置")} onClick={closeDialog}><Icon name="close" /></button>
          </header>

          <div className="settings-content">
            {activeSection === 'general' && (
              <GeneralTab
                avatarInputError={avatarInputError}
                chooseDirectory={chooseDirectory}
                hasTestTerminalShellHandler={Boolean(onTestTerminalShell)}
                models={models}
                preferenceDraft={preferenceDraft}
                selectAvatarFile={selectAvatarFile}
                setAvatarInputError={setAvatarInputError}
                setPreferenceDraft={setPreferenceDraft}
                terminalShellTest={terminalShellTest}
                testTerminalShell={testTerminalShell}
                testingTerminalShell={testingTerminalShell}
              />
            )}
            {activeSection === 'runtimes' && (
              <RuntimesTab
                chooseDirectory={chooseDirectory}
                onListCondaEnvironments={onListCondaEnvironments}
                onTestRuntime={onTestRuntime}
                preferenceDraft={preferenceDraft}
                setPreferenceDraft={setPreferenceDraft}
              />
            )}
            {activeSection === 'skills' && (
              <SkillsTab
                skills={skills}
                onRemoveSkill={onRemoveSkill}
                onResetDefaultSkills={onResetDefaultSkills}
                onToggleSkill={onToggleSkill}
                onUpsertSkill={onUpsertSkill}
              />
            )}
            
            {activeSection === 'mcp' && (
              <McpTab
                mcpServers={mcpServers}
                onListMcpTools={onListMcpTools}
                onRemoveMcpServer={onRemoveMcpServer}
                onTestMcpServer={onTestMcpServer}
                onToggleMcpServer={onToggleMcpServer}
                onUpsertMcpServer={onUpsertMcpServer}
                preferenceDraft={preferenceDraft}
                setPreferenceDraft={setPreferenceDraft}
                skills={skills}
              />
            )}
            {activeSection === 'models' && (
              <ModelsTab
                modelDrafts={modelDrafts}
                onDiscoverModels={onDiscoverModels}
                preferenceDraft={preferenceDraft}
                providerDrafts={providerDrafts}
                setModelDrafts={setModelDrafts}
              />
            )}
            {activeSection === 'providers' && (
              <ProvidersTab
                apiKeyInputs={apiKeyInputs}
                clearApiKeyIds={clearApiKeyIds}
                onTestProvider={onTestProvider}
                providerDrafts={providerDrafts}
                providersRequiringNewKey={providersRequiringNewKey}
                setApiKeyInputs={setApiKeyInputs}
                setClearApiKeyIds={setClearApiKeyIds}
                setModelDrafts={setModelDrafts}
                setProviderDrafts={setProviderDrafts}
              />
            )}
            {activeSection === 'security' && (
              <SecurityTab
                backupConfiguring={backupConfiguring}
                backupError={backupError}
                backupExporting={backupExporting}
                backupMode={backupMode}
                backupPassword={backupPassword}
                backupPasswordConfirmation={backupPasswordConfirmation}
                backupProtectionEnabled={backupProtectionEnabled}
                backupResult={backupResult}
                clearConfirming={clearConfirming}
                clearError={clearError}
                clearing={clearing}
                confirmClearData={confirmClearData}
                exportBackup={exportBackup}
                hasClearDataHandler={Boolean(onClearData)}
                hasExportBackupHandler={Boolean(onExportBackup)}
                setBackupConfiguring={setBackupConfiguring}
                setBackupError={setBackupError}
                setBackupMode={setBackupMode}
                setBackupPassword={setBackupPassword}
                setBackupPasswordConfirmation={setBackupPasswordConfirmation}
                setBackupResult={setBackupResult}
                setClearConfirming={setClearConfirming}
                setClearError={setClearError}
              />
            )}
            {activeSection === 'about' && (
              <AboutTab />
            )}
          </div>

          <footer className="settings-footer">
            <span className={saveError ? 'settings-save-error' : ''}>
              {saveError || t("更改将安全地保存在本机")}
            </span>
            <div>
              <button className="secondary-button" onClick={closeDialog}>{t("取消")}</button>
              <button className="primary-button" disabled={saving || providersRequiringNewKey.length > 0} onClick={save}>
                {saving ? t("保存中…") : t("保存更改")}
              </button>
            </div>
          </footer>
        </div>
      </section>
      {avatarCropSource && (
        <AvatarCropDialog
          onCancel={() => setAvatarCropSource(null)}
          onComplete={(userAvatar) => {
            setPreferenceDraft((current) => ({ ...current, userAvatar }))
            setAvatarCropSource(null)
            setAvatarInputError('')
          }}
          sourceUrl={avatarCropSource}
        />
      )}
    </div>
  )
}
