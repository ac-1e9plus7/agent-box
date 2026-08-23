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
                  <div><h3>{t("本地数据保护已启用")}</h3><p>{t("会话、配置与 API 密钥在写入磁盘前都会加密。")}</p></div>
                  <i><Icon name="check" size={14} />{t("已保护")}</i>
                </div>
                <section className="settings-card">
                  <div className="settings-row">
                    <div><strong>{t("API 密钥")}</strong><small>{t("由操作系统凭据保护机制加密")}</small></div>
                    <span className="security-state"><Icon name="check" size={14} />{t("安全")}</span>
                  </div>
                  <div className="settings-row">
                    <div><strong>{t("会话数据库")}</strong><small>{t("仅保存在此设备的应用数据目录")}</small></div>
                    <span className="security-state"><Icon name="check" size={14} />{t("本地")}</span>
                  </div>
                </section>
                <section className={`settings-card export-card ${backupConfiguring ? 'is-configuring' : ''}`}>
                  <div className="export-card-head">
                    <div>
                      <Icon name="archive" size={20} />
                      <span>
                        <strong>{t("导出加密备份")}</strong>
                        <small>{t("以明文 JSON 与 Markdown 导出全部会话，可选包含工作目录")}</small>
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
                      {backupConfiguring ? t("收起") : t("配置并导出")}
                    </button>
                  </div>
                  {backupConfiguring && (
                    <div className="backup-export-panel">
                      <fieldset className="backup-mode-options" disabled={backupExporting}>
                        <legend>{t("备份模式")}</legend>
                        <label className={backupMode === 'shallow' ? 'is-selected' : ''}>
                          <input
                            checked={backupMode === 'shallow'}
                            name="backup-mode"
                            onChange={() => setBackupMode('shallow')}
                            type="radio"
                          />
                          <span><strong>{t("浅备份")}</strong><small>{t("全部会话、分支、附件与 Agent 记录，不复制工作目录")}</small></span>
                        </label>
                        <label className={backupMode === 'deep' ? 'is-selected' : ''}>
                          <input
                            checked={backupMode === 'deep'}
                            name="backup-mode"
                            onChange={() => setBackupMode('deep')}
                            type="radio"
                          />
                          <span><strong>{t("深备份")}</strong><small>{t("在浅备份基础上，递归包含所有去重后的会话工作目录")}</small></span>
                        </label>
                      </fieldset>

                      <div className="backup-password-fields">
                        <label>
                          <span>{t("ZIP 密码（可选，建议设置）")}</span>
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
                            placeholder={t("建议使用至少 12 位独立密码")}
                            type="password"
                            value={backupPassword}
                          />
                        </label>
                        <label>
                          <span>{t("确认密码")}</span>
                          <input
                            autoComplete="new-password"
                            disabled={backupExporting || !backupPassword}
                            maxLength={256}
                            onChange={(event) => {
                              setBackupPasswordConfirmation(event.target.value)
                              setBackupError('')
                            }}
                            placeholder={backupPassword ? t("再次输入密码") : t("未设置密码")}
                            type="password"
                            value={backupPasswordConfirmation}
                          />
                        </label>
                      </div>

                      <div className={`backup-security-note ${backupProtectionEnabled ? 'is-protected' : 'is-warning'}`}>
                        <Icon name={backupProtectionEnabled ? 'lock' : 'info'} size={16} />
                        <span>
                          <strong>{backupResult
                            ? backupProtectionEnabled ? t("本次备份已使用 ZIP AES-256 加密") : t("本次备份未设置密码")
                            : backupProtectionEnabled ? t("将使用 ZIP AES-256 加密文件内容") : t("当前将导出未加密的明文 ZIP")}</strong>
                          <small>
                            {backupProtectionEnabled
                              ? t("AgentBox 不保存密码；ZIP 条目名称仍可能被查看，深备份会暴露工作目录文件名。")
                              : t("会话、附件与深备份文件可被直接读取。建议设置密码后再导出。")}
                          </small>
                        </span>
                      </div>

                      {backupError && <p className="backup-export-error" role="alert">{backupError}</p>}
                      {backupResult && (
                        <div className="backup-export-success" role="status">
                          <Icon name="check" size={15} />
                          <span>
                            <strong>{t("备份已导出")}</strong>
                            <small>
                              {t("{value0} 个会话", { value0: backupResult.conversationCount })}{backupResult.mode === 'deep' ? t("，{value0} 个工作目录", { value0: backupResult.workspaceCount }) : ''}
                              {backupResult.bytesWritten !== undefined ? `，${formatFileSize(backupResult.bytesWritten)}` : ''}
                              {backupResult.filePath ? ` · ${backupResult.filePath}` : ''}
                            </small>
                          </span>
                        </div>
                      )}

                      <div className="backup-export-actions">
                        <small>{t("API 密钥、Vault 密钥、服务商及应用设置不会进入导出包。")}</small>
                        <button
                          className="primary-button"
                          disabled={!onExportBackup || backupExporting || backupPassword !== backupPasswordConfirmation}
                          onClick={() => void exportBackup()}
                        >
                          {backupExporting ? <><span className="button-spinner" />{t("正在创建 ZIP…")}</> : <><Icon name="archive" size={14} />{t("选择位置并导出")}</>}
                        </button>
                      </div>
                    </div>
                  )}
                </section>
                <section className="settings-card danger-card">
                  <div className="danger-card-head">
                    <Icon name="trash" size={20} />
                    <span>
                      <strong>{t("清除全部会话数据")}</strong>
                      <small>{t("删除所有对话与消息，重新加密本地数据。不会清除已配置的供应商与模型。")}</small>
                    </span>
                  </div>
                  {clearError && <p className="danger-card-error">{clearError}</p>}
                  {clearConfirming ? (
                    <div className="danger-card-confirm">
                      <p>{t("将永久删除全部会话，此操作无法撤销。确定继续吗？")}</p>
                      <div className="danger-card-actions">
                        <button
                          className="secondary-button"
                          disabled={clearing}
                          onClick={() => { setClearConfirming(false); setClearError('') }}
                        >{t("取消")}</button>
                        <button
                          className="danger-button"
                          disabled={clearing}
                          onClick={() => void confirmClearData()}
                        >
                          {clearing ? t("清除中…") : t("确认清除")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      className="danger-button"
                      disabled={!onClearData}
                      onClick={() => setClearConfirming(true)}
                    >
                      <Icon name="trash" size={14} />{t("清除全部会话数据")}</button>
                  )}
                </section>
              </div>
  )
}
