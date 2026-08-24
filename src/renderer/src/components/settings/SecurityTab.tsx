import type { Dispatch, JSX, SetStateAction } from 'react'
import type { BackupMode, ExportBackupResult } from '../../../../shared/types'
import { formatFileSize } from '../../file-helper'
import { t } from '../../../../shared/i18n'
import { Icon } from '../Icon'

interface SecurityTabProps {
  backupConfiguring: boolean
  backupError: string
  backupExporting: boolean
  backupMode: BackupMode
  backupPassword: string
  backupPasswordConfirmation: string
  backupProtectionEnabled: boolean
  backupResult: ExportBackupResult | null
  clearConfirming: boolean
  clearError: string
  clearing: boolean
  confirmClearData: () => Promise<void>
  exportBackup: () => Promise<void>
  hasClearDataHandler: boolean
  hasExportBackupHandler: boolean
  setBackupConfiguring: Dispatch<SetStateAction<boolean>>
  setBackupError: Dispatch<SetStateAction<string>>
  setBackupMode: Dispatch<SetStateAction<BackupMode>>
  setBackupPassword: Dispatch<SetStateAction<string>>
  setBackupPasswordConfirmation: Dispatch<SetStateAction<string>>
  setBackupResult: Dispatch<SetStateAction<ExportBackupResult | null>>
  setClearConfirming: Dispatch<SetStateAction<boolean>>
  setClearError: Dispatch<SetStateAction<string>>
}

export function SecurityTab({
  backupConfiguring,
  backupError,
  backupExporting,
  backupMode,
  backupPassword,
  backupPasswordConfirmation,
  backupProtectionEnabled,
  backupResult,
  clearConfirming,
  clearError,
  clearing,
  confirmClearData,
  exportBackup,
  hasClearDataHandler: onClearData,
  hasExportBackupHandler: onExportBackup,
  setBackupConfiguring,
  setBackupError,
  setBackupMode,
  setBackupPassword,
  setBackupPasswordConfirmation,
  setBackupResult,
  setClearConfirming,
  setClearError,
}: SecurityTabProps): JSX.Element {
  return (
              <div className="settings-section-content narrow-settings">
                <div className="encryption-hero">
                  <span><Icon name="shield" size={29} /></span>
                  <div><h3>{t("Local data protection is enabled")}</h3><p>{t("Conversations, configuration, and API keys are encrypted before being written to disk.")}</p></div>
                  <i><Icon name="check" size={14} />{t("Protected")}</i>
                </div>
                <section className="settings-card">
                  <div className="settings-row">
                    <div><strong>{t("API key")}</strong><small>{t("Encrypted using OS credential protection")}</small></div>
                    <span className="security-state"><Icon name="check" size={14} />{t("Secure")}</span>
                  </div>
                  <div className="settings-row">
                    <div><strong>{t("Conversation database")}</strong><small>{t("Stored only in this device’s app data directory")}</small></div>
                    <span className="security-state"><Icon name="check" size={14} />{t("Local")}</span>
                  </div>
                </section>
                <section className={`settings-card export-card ${backupConfiguring ? 'is-configuring' : ''}`}>
                  <div className="export-card-head">
                    <div>
                      <Icon name="archive" size={20} />
                      <span>
                        <strong>{t("backup.exportEncrypted")}</strong>
                        <small>{t("Export all conversations as plaintext JSON and Markdown, optionally including working directories")}</small>
                      </span>
                    </div>
                    <button
                      className="secondary-button"
                      disabled={!onExportBackup || backupExporting}
                      onClick={() => {
                        setBackupConfiguring((current) => !current)
                        setBackupError('')
                        setBackupResult(null)
                      }}
                    >
                      {backupConfiguring ? t("Collapse") : t("Configure and export")}
                    </button>
                  </div>
                  {backupConfiguring && (
                    <div className="backup-export-panel">
                      <fieldset className="backup-mode-options" disabled={backupExporting}>
                        <legend>{t("Backup mode")}</legend>
                        <label className={backupMode === 'shallow' ? 'is-selected' : ''}>
                          <input
                            checked={backupMode === 'shallow'}
                            name="backup-mode"
                            onChange={() => setBackupMode('shallow')}
                            type="radio"
                          />
                          <span><strong>{t("Shallow backup")}</strong><small>{t("All conversations, branches, attachments, and Agent records; excludes working directories")}</small></span>
                        </label>
                        <label className={backupMode === 'deep' ? 'is-selected' : ''}>
                          <input
                            checked={backupMode === 'deep'}
                            name="backup-mode"
                            onChange={() => setBackupMode('deep')}
                            type="radio"
                          />
                          <span><strong>{t("Deep backup")}</strong><small>{t("Includes everything in a shallow backup plus all unique conversation working directories recursively")}</small></span>
                        </label>
                      </fieldset>

                      <div className="backup-password-fields">
                        <label>
                          <span>{t("ZIP password (optional, recommended)")}</span>
                          <input
                            autoComplete="new-password"
                            disabled={backupExporting}
                            maxLength={256}
                            onChange={(event) => {
                              const nextPassword = event.target.value
                              setBackupPassword(nextPassword)
                              if (!nextPassword) setBackupPasswordConfirmation('')
                              setBackupError('')
                              setBackupResult(null)
                            }}
                            placeholder={t("Use a unique password with at least 12 characters")}
                            type="password"
                            value={backupPassword}
                          />
                        </label>
                        <label>
                          <span>{t("Confirm password")}</span>
                          <input
                            autoComplete="new-password"
                            disabled={backupExporting || !backupPassword}
                            maxLength={256}
                            onChange={(event) => {
                              setBackupPasswordConfirmation(event.target.value)
                              setBackupError('')
                            }}
                            placeholder={backupPassword ? t("Enter password again") : t("No password set")}
                            type="password"
                            value={backupPasswordConfirmation}
                          />
                        </label>
                      </div>

                      <div className={`backup-security-note ${backupProtectionEnabled ? 'is-protected' : 'is-warning'}`}>
                        <Icon name={backupProtectionEnabled ? 'lock' : 'info'} size={16} />
                        <span>
                          <strong>{backupResult
                            ? backupProtectionEnabled ? t("This backup is protected with WinZip AES-256 (AE-2)") : t("This backup is not password-protected")
                            : backupProtectionEnabled ? t("File contents will be protected with WinZip AES-256 (AE-2)") : t("An unencrypted plaintext ZIP will be exported")}</strong>
                          <small>
                            {backupProtectionEnabled
                              ? t("AgentBox does not store passwords. ZIP entry names remain visible, and deep backups expose file names from working directories.")
                              : t("Conversations, attachments, and files in a deep backup can be read directly. Set a password before exporting.")}
                          </small>
                        </span>
                      </div>

                      {backupError && <p className="backup-export-error" role="alert">{backupError}</p>}
                      {backupResult && (
                        <div className="backup-export-success" role="status">
                          <Icon name="check" size={15} />
                          <span>
                            <strong>{t("Backup exported")}</strong>
                            <small>
                              {t("{value0} conversations", { value0: backupResult.conversationCount })}{backupResult.mode === 'deep' ? t(", {value0} working directories", { value0: backupResult.workspaceCount }) : ''}
                              {backupResult.bytesWritten !== undefined ? t(", {value0}", { value0: formatFileSize(backupResult.bytesWritten) }) : ''}
                              {backupResult.filePath ? ` · ${backupResult.filePath}` : ''}
                            </small>
                          </span>
                        </div>
                      )}

                      <div className="backup-export-actions">
                        <small>{t("API keys, Vault keys, providers, and app settings are not included in the export.")}</small>
                        <button
                          className="primary-button"
                          disabled={!onExportBackup || backupExporting || backupPassword !== backupPasswordConfirmation}
                          onClick={() => void exportBackup()}
                        >
                          {backupExporting ? <><span className="button-spinner" />{t("Creating ZIP…")}</> : <><Icon name="archive" size={14} />{t("Choose location and export")}</>}
                        </button>
                      </div>
                    </div>
                  )}
                </section>
                <section className="settings-card danger-card">
                  <div className="danger-card-head">
                    <Icon name="trash" size={20} />
                    <span>
                      <strong>{t("Clear all conversation data")}</strong>
                      <small>{t("Deletes all conversations and messages, then re-encrypts local data. Configured providers and models are kept.")}</small>
                    </span>
                  </div>
                  {clearError && <p className="danger-card-error">{clearError}</p>}
                  {clearConfirming ? (
                    <div className="danger-card-confirm">
                      <p>{t("This permanently deletes every conversation and cannot be undone. Continue?")}</p>
                      <div className="danger-card-actions">
                        <button
                          className="secondary-button"
                          disabled={clearing}
                          onClick={() => { setClearConfirming(false); setClearError('') }}
                        >{t("Cancel")}</button>
                        <button
                          className="danger-button"
                          disabled={clearing}
                          onClick={() => void confirmClearData()}
                        >
                          {clearing ? t("Clearing…") : t("Clear data")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      className="danger-button"
                      disabled={!onClearData}
                      onClick={() => setClearConfirming(true)}
                    >
                      <Icon name="trash" size={14} />{t("Clear all conversation data")}</button>
                  )}
                </section>
              </div>
  )
}
