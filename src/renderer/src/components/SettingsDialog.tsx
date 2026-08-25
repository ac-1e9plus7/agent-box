import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import type { AppPreferences, ModelConfig, ProviderConfig, SettingsSection } from '../types'
import type {
  BackupMode,
  CondaEnvironmentListResult,
  DeveloperRuntimeKind,
  DeveloperRuntimeSettings,
  ExportBackupInput,
  ExportBackupResult,
  IntegratedTerminalShellConfig,
  McpServerConfig,
  McpServerInput,
  McpServerTestResult,
  McpToolDefinition,
  RemoteModel,
  RuntimeTestResult,
  Skill,
  SkillInput,
  TerminalShellTestResult,
} from '../../../shared/types'
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
  onTestRuntime?: (
    kind: DeveloperRuntimeKind,
    settings: DeveloperRuntimeSettings,
    workingDirectory?: string,
  ) => Promise<RuntimeTestResult>
  onListCondaEnvironments?: (condaExecutable: string) => Promise<CondaEnvironmentListResult>
}

const settingsNav: Array<{ id: SettingsSection; label: string; icon: Parameters<typeof Icon>[0]['name'] }> = [
  { id: 'general', label: t('General'), icon: 'settings' },
  { id: 'runtimes', label: t('Developer runtimes'), icon: 'code' },
  { id: 'skills', label: t('Agent skills'), icon: 'bot' },
  { id: 'mcp', label: t('MCP tools'), icon: 'tool' },
  { id: 'models', label: t('Model'), icon: 'sparkles' },
  { id: 'providers', label: t('Provider'), icon: 'globe' },
  { id: 'security', label: t('Data and security'), icon: 'shield' },
  { id: 'about', label: t('About'), icon: 'info' },
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
  const integratedTerminalShellArgs = preferenceDraft.integratedTerminalShell.args.join('\0')

  useEffect(() => {
    setTerminalShellTest(null)
  }, [
    preferenceDraft.integratedTerminalShell.mode,
    preferenceDraft.integratedTerminalShell.executable,
    integratedTerminalShellArgs,
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
      setClearError(error instanceof Error ? error.message : t('Could not clear the data. Try again.'))
    } finally {
      setClearing(false)
    }
  }

  const exportBackup = async (): Promise<void> => {
    if (!onExportBackup || backupExporting) return
    if (backupPassword !== backupPasswordConfirmation) {
      setBackupError(t('The backup passwords do not match.'))
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
      setBackupError(error instanceof Error ? error.message : t('Could not export the backup. Try again.'))
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

  useEffect(
    () => () => {
      if (avatarCropSource) URL.revokeObjectURL(avatarCropSource)
    },
    [avatarCropSource],
  )

  const selectAvatarFile = (file: File | undefined): void => {
    if (!file) return
    try {
      validateAvatarSourceFile(file)
      setAvatarInputError('')
      setAvatarCropSource(URL.createObjectURL(file))
    } catch (error) {
      setAvatarInputError(error instanceof Error ? error.message : t('Unable to read avatar image.'))
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

  const providersRequiringNewKey = useMemo(
    () =>
      providerDrafts.filter((provider) => {
        const original = providers.find((item) => item.id === provider.id)
        if (!original?.hasApiKey) return false
        const credentialScopeChanged = original.baseUrl !== provider.baseUrl || original.kind !== provider.kind
        return (
          credentialScopeChanged && !(apiKeyInputs[provider.id] ?? '').trim() && !clearApiKeyIds.includes(provider.id)
        )
      }),
    [apiKeyInputs, clearApiKeyIds, providerDrafts, providers],
  )

  if (!open) return null

  const save = async (): Promise<void> => {
    if (providersRequiringNewKey.length > 0) {
      setSaveError(
        t('The connection address or type of "{value0}" has changed, please re-enter the API key.', {
          value0: providersRequiringNewKey[0]?.name ?? t('Provider'),
        }),
      )
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
        clearApiKeyIds,
      })
      setApiKeyInputs({})
      closeDialog()
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : t('Saving failed. Check the configuration and try again.'))
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
        message: error instanceof Error ? error.message : t('Shell test failed'),
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
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) closeDialog()
      }}
    >
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-label={t('Settings')}>
        <aside className="settings-sidebar">
          <div className="settings-brand">
            <span className="brand-mark">
              <Icon name="app" size={21} />
            </span>
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
            <span>
              <strong>{t('Privacy first')}</strong>
              <small>{t('Keys and data stay on this device')}</small>
            </span>
          </div>
        </aside>

        <div className="settings-main">
          <header className="settings-header">
            <div>
              <h2>{settingsNav.find((item) => item.id === activeSection)?.label}</h2>
              <p>{activeSection === 'general' && t('Adjust AgentBox preferences')}</p>
              <p>
                {activeSection === 'runtimes' &&
                  t('Configure the default JDK, Go, PHP, and Python environments for projects')}
              </p>
              <p>{activeSection === 'skills' && t('Manage, install, and customize Agent Skills')}</p>
              <p>
                {activeSection === 'mcp' &&
                  t('Connect and manage external tool servers through the Model Context Protocol (MCP)')}
              </p>
              <p>
                {activeSection === 'models' && t('Configure model capabilities, context windows and request formats')}
              </p>
              <p>{activeSection === 'providers' && t('Manage API endpoints and access keys')}</p>
              <p>{activeSection === 'security' && t('Learn about local encryption and system secure storage')}</p>
              <p>{activeSection === 'about' && t('About AgentBox and system information')}</p>
            </div>
            <button className="icon-button" aria-label={t('Close settings')} onClick={closeDialog}>
              <Icon name="close" />
            </button>
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
            {activeSection === 'about' && <AboutTab />}
          </div>

          <footer className="settings-footer">
            <span className={saveError ? 'settings-save-error' : ''}>
              {saveError || t('Changes are stored securely on this device')}
            </span>
            <div>
              <button className="secondary-button" onClick={closeDialog}>
                {t('Cancel')}
              </button>
              <button
                className="primary-button"
                disabled={saving || providersRequiringNewKey.length > 0}
                onClick={save}
              >
                {saving ? t('Saving…') : t('Save changes')}
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
