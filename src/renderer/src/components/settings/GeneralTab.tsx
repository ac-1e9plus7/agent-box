import type { Dispatch, JSX, SetStateAction } from 'react'
import type { TerminalShellTestResult } from '../../../../shared/types'
import type { AppPreferences, ModelConfig } from '../../types'
import { DEFAULT_AGENT_TOOL_TURN_LIMIT } from '../../../../shared/agent-limits'
import { MAX_USER_NICKNAME_LENGTH } from '../../../../shared/user-profile'
import { t } from '../../../../shared/i18n'
import { Icon } from '../Icon'
import {
  AgentTurnLimitInput,
  FieldLabel,
  SettingsToggle,
} from './SettingsControls'

interface GeneralTabProps {
  avatarInputError: string
  chooseDirectory: (current?: string) => Promise<string | undefined>
  hasTestTerminalShellHandler: boolean
  models: ModelConfig[]
  preferenceDraft: AppPreferences
  selectAvatarFile: (file: File | undefined) => void
  setAvatarInputError: Dispatch<SetStateAction<string>>
  setPreferenceDraft: Dispatch<SetStateAction<AppPreferences>>
  terminalShellTest: TerminalShellTestResult | null
  testTerminalShell: () => Promise<void>
  testingTerminalShell: boolean
}

export function GeneralTab({
  avatarInputError,
  chooseDirectory,
  hasTestTerminalShellHandler: onTestTerminalShell,
  models,
  preferenceDraft,
  selectAvatarFile,
  setAvatarInputError,
  setPreferenceDraft,
  terminalShellTest,
  testTerminalShell,
  testingTerminalShell,
}: GeneralTabProps): JSX.Element {
  return (
              <div className="settings-section-content narrow-settings">
                <section className="settings-card user-profile-card">
                  <h3>{t("个人资料")}</h3>
                  <div className="user-profile-settings">
                    <div className={`user-profile-avatar-preview ${preferenceDraft.userAvatar ? 'has-image' : ''}`}>
                      {preferenceDraft.userAvatar
                        ? <img alt={t("当前头像")} src={preferenceDraft.userAvatar} />
                        : <Icon name="user" size={28} />}
                    </div>
                    <div className="user-profile-fields">
                      <label>
                        <FieldLabel hint={t("最多 {value0} 个字符，可留空", { value0: MAX_USER_NICKNAME_LENGTH })}>{t("昵称")}</FieldLabel>
                        <input
                          maxLength={MAX_USER_NICKNAME_LENGTH}
                          onChange={(event) => setPreferenceDraft((current) => ({
                            ...current,
                            userNickname: event.target.value,
                          }))}
                          placeholder={t("你希望显示的名字")}
                          type="text"
                          value={preferenceDraft.userNickname ?? ''}
                        />
                      </label>
                      <div className="user-profile-avatar-actions">
                        <label className="secondary-button">
                          <Icon name="image" size={14} />
                          {preferenceDraft.userAvatar ? t("更换头像") : t("选择头像")}
                          <input
                            accept="image/*"
                            onChange={(event) => {
                              selectAvatarFile(event.currentTarget.files?.[0])
                              event.currentTarget.value = ''
                            }}
                            type="file"
                          />
                        </label>
                        {preferenceDraft.userAvatar && (
                          <button
                            className="secondary-button"
                            onClick={() => setPreferenceDraft((current) => ({ ...current, userAvatar: '' }))}
                            type="button"
                          >{t("移除")}</button>
                        )}
                      </div>
                    </div>
                  </div>
                  <p className="user-profile-note">
                    <Icon name="shield" size={13} />{t("昵称与头像仅用于本地界面展示，不会加入任何提示词或发送给模型。")}</p>
                  {avatarInputError && <p className="user-profile-error" role="alert">{avatarInputError}</p>}
                </section>
                <section className="settings-card">
                  <h3>{t("外观与行为")}</h3>
                  <div className="settings-row">
                    <div><strong>{t('language.settingLabel')}</strong><small>{t('language.settingHint')}</small></div>
                    <select
                      aria-label={t('language.settingLabel')}
                      value={preferenceDraft.language}
                      onChange={(event) => setPreferenceDraft((current) => ({
                        ...current,
                        language: event.target.value as AppPreferences['language']
                      }))}
                    >
                      <option value="zh-CN">{t("简体中文")}</option>
                      <option value="en-US">{t('language.englishName')}</option>
                    </select>
                  </div>
                  <div className="settings-row">
                    <div><strong>{t("主题")}</strong><small>{t("跟随系统或使用固定主题")}</small></div>
                    <div className="segmented-control">
                      {(['system', 'light', 'dark'] as const).map((theme) => (
                        <button
                          className={preferenceDraft.theme === theme ? 'is-active' : ''}
                          key={theme}
                          onClick={() => setPreferenceDraft((current) => ({ ...current, theme }))}
                        >
                          {theme === 'system' ? t("跟随系统") : theme === 'light' ? t("浅色") : t("深色")}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="settings-row">
                    <div><strong>{t("新会话默认 Agent 模式")}</strong><small>{t("新建对话时默认开启智能体模式与技能注入")}</small></div>
                    <SettingsToggle
                      checked={Boolean(preferenceDraft.defaultAgentMode)}
                      label={t("新会话默认 Agent 模式")}
                      onChange={(defaultAgentMode) => setPreferenceDraft((current) => ({ ...current, defaultAgentMode }))}
                    />
                  </div>
                  <div className="settings-row">
                    <div><strong>{t("Agent 工具调用轮次")}</strong><small>{t("范围 1–100，默认 {value0}；提高上限会增加耗时和 API 费用", { value0: DEFAULT_AGENT_TOOL_TURN_LIMIT })}</small></div>
                    <AgentTurnLimitInput
                      onChange={(agentToolTurnLimit) => setPreferenceDraft((current) => ({ ...current, agentToolTurnLimit }))}
                      value={preferenceDraft.agentToolTurnLimit ?? DEFAULT_AGENT_TOOL_TURN_LIMIT}
                    />
                  </div>
                  <div className="settings-row">
                    <div><strong>{t("新会话默认思考")}</strong><small>{t("支持推理的模型将自动开启")}</small></div>
                    <SettingsToggle
                      checked={preferenceDraft.defaultReasoningEnabled}
                      label={t("新会话默认思考")}
                      onChange={(defaultReasoningEnabled) => setPreferenceDraft((current) => ({ ...current, defaultReasoningEnabled }))}
                    />
                  </div>
                  <div className="settings-row">
                    <div><strong>{t("新模型思考强度")}</strong><small>{t("添加模型时作为默认初始值，可在模型页单独调整")}</small></div>
                    <select
                      value={preferenceDraft.defaultReasoningEffort}
                      onChange={(event) => setPreferenceDraft((current) => ({
                        ...current,
                        defaultReasoningEffort: event.target.value as AppPreferences['defaultReasoningEffort']
                      }))}
                    >
                      <option value="minimal">{t("极简")}</option>
                      <option value="low">{t("低")}</option>
                      <option value="medium">{t("中")}</option>
                      <option value="high">{t("高")}</option>
                      <option value="xhigh">{t("很高")}</option>
                      <option value="max">{t("最高")}</option>
                    </select>
                  </div>
                </section>
                <section className="settings-card">
                  <h3>{t("输入")}</h3>
                  <div className="settings-row">
                    <div><strong>{t("按 Enter 发送")}</strong><small>{t("关闭后使用 ⌘/Ctrl + Enter 发送")}</small></div>
                    <SettingsToggle
                      checked={preferenceDraft.sendShortcut === 'enter'}
                      label={t("按 Enter 发送")}
                      onChange={(sendOnEnter) => setPreferenceDraft((current) => ({
                        ...current,
                        sendShortcut: sendOnEnter ? 'enter' : 'mod-enter'
                      }))}
                    />
                  </div>
                  <label className="system-prompt-field">
                    <FieldLabel hint={t("每次请求时添加，可留空")}>{t("系统提示词")}</FieldLabel>
                    <textarea
                      placeholder={t("例如：请始终使用简体中文回答…")}
                      rows={5}
                      value={preferenceDraft.systemPrompt}
                      onChange={(event) => setPreferenceDraft((current) => ({ ...current, systemPrompt: event.target.value }))}
                    />
                  </label>
                  <div className="settings-row" style={{ marginTop: '16px' }}>
                    <div><strong>{t("自动命名模型")}</strong><small>{t("对话产生时自动生成标题所用的模型")}</small></div>
                    <select
                      value={preferenceDraft.titleGenerationModelId ?? ''}
                      onChange={(event) => setPreferenceDraft((current) => ({
                        ...current,
                        titleGenerationModelId: event.target.value === '' ? undefined : event.target.value
                      }))}
                    >
                      <option value="">{t("跟随当前会话模型")}</option>
                      {models.map((model) => (
                        <option key={model.id} value={model.id}>{model.name}</option>
                      ))}
                    </select>
                  </div>
                </section>
                <section className="settings-card">
                  <h3>{t("默认工作目录")}</h3>
                  <div className="settings-row workspace-default-row">
                    <div>
                      <strong>{t("默认工作目录")}</strong>
                      <small>{t("在新建对话面板中作为快捷选项；仍可复用已有目录或另选目录")}</small>
                    </div>
                    <div className="workspace-default-actions">
                      <button
                        className="secondary-button"
                        onClick={async () => {
                          const selected = await chooseDirectory(preferenceDraft.defaultWorkingDirectory)
                          if (selected) setPreferenceDraft((current) => ({ ...current, defaultWorkingDirectory: selected }))
                        }}
                        type="button"
                      >
                        <Icon name="folder" size={14} />{t("选择目录")}</button>
                      {preferenceDraft.defaultWorkingDirectory && (
                        <button className="icon-button" aria-label={t("清除默认工作目录")} onClick={() => setPreferenceDraft((current) => ({ ...current, defaultWorkingDirectory: '' }))}>
                          <Icon name="close" size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="workspace-default-path" title={preferenceDraft.defaultWorkingDirectory}>
                    {preferenceDraft.defaultWorkingDirectory || t("未设置；新建对话时需要选择工作目录")}
                  </p>
                </section>
                <section className="settings-card context-policy-card">
                  <h3>{t("上下文管理")}</h3>
                  <div className="context-policy-options">
                    <button
                      className={preferenceDraft.contextManagementMode === 'manual' ? 'is-active' : ''}
                      onClick={() => setPreferenceDraft((current) => ({ ...current, contextManagementMode: 'manual' }))}
                    >
                      <span className="policy-radio"><i /></span>
                      <span>
                        <strong>{t("手动管理")}<em>{t("默认")}</em></strong>
                        <small>{t("保留全部历史。超过模型可用上下文时会阻止发送，由你调整会话或上下文窗口。")}</small>
                      </span>
                    </button>
                    <button
                      className={preferenceDraft.contextManagementMode === 'auto' ? 'is-active' : ''}
                      onClick={() => setPreferenceDraft((current) => ({ ...current, contextManagementMode: 'auto' }))}
                    >
                      <span className="policy-radio"><i /></span>
                      <span>
                        <strong>{t("自动裁剪")}</strong>
                        <small>{t("超限时从最早的对话开始，按完整的用户＋助手轮次裁剪；系统提示词与最新问题始终保留。")}</small>
                      </span>
                    </button>
                  </div>
                </section>
                <section className="settings-card context-policy-card">
                  <h3>{t('terminal.integratedShell')}</h3>
                  <div className="context-policy-options">
                    <button
                      className={preferenceDraft.integratedTerminalShell.mode === 'auto' ? 'is-active' : ''}
                      onClick={() => setPreferenceDraft((current) => ({
                        ...current,
                        integratedTerminalShell: { ...current.integratedTerminalShell, mode: 'auto' }
                      }))}
                    >
                      <span className="policy-radio"><i /></span>
                      <span>
                        <strong>{t("自动选择")}<em>{t("推荐")}</em></strong>
                        <small>{t("Windows 依次尝试 PowerShell 7、Windows PowerShell、cmd；macOS/Linux 优先使用 SHELL，再尝试 zsh、bash、fish 或 sh。")}</small>
                      </span>
                    </button>
                    <button
                      className={preferenceDraft.integratedTerminalShell.mode === 'custom' ? 'is-active' : ''}
                      onClick={() => setPreferenceDraft((current) => ({
                        ...current,
                        integratedTerminalShell: { ...current.integratedTerminalShell, mode: 'custom' }
                      }))}
                    >
                      <span className="policy-radio"><i /></span>
                      <span>
                        <strong>{t("指定 Shell")}</strong>
                        <small>{t("使用可执行文件名或绝对路径，并可逐行添加启动参数。")}</small>
                      </span>
                    </button>
                  </div>
                  {preferenceDraft.integratedTerminalShell.mode === 'custom' && (
                    <div className="terminal-shell-fields">
                      <label className="system-prompt-field">
                        <FieldLabel hint={t("例如：pwsh.exe、C:\\Program Files\\PowerShell\\7\\pwsh.exe、/bin/zsh、/usr/bin/fish")}>{t("Shell 可执行文件")}</FieldLabel>
                        <input
                          className="mono-input"
                          placeholder={t("Shell 可执行文件名或绝对路径")}
                          value={preferenceDraft.integratedTerminalShell.executable}
                          onChange={(event) => setPreferenceDraft((current) => ({
                            ...current,
                            integratedTerminalShell: { ...current.integratedTerminalShell, executable: event.target.value }
                          }))}
                        />
                      </label>
                      <label className="system-prompt-field">
                        <FieldLabel hint={t("每行一个参数。已知 Shell 会自动添加命令参数；其他 Shell 可使用 {command} 占位符。")}>{t("启动参数")}</FieldLabel>
                        <textarea
                          className="mono-input terminal-shell-args"
                          placeholder={t("例如：\n-NoLogo\n-NoProfile")}
                          value={preferenceDraft.integratedTerminalShell.args.join('\n')}
                          onChange={(event) => setPreferenceDraft((current) => ({
                            ...current,
                            integratedTerminalShell: {
                              ...current.integratedTerminalShell,
                              args: event.target.value.split(/\r?\n/).filter((argument) => argument.length > 0)
                            }
                          }))}
                        />
                      </label>
                    </div>
                  )}
                  <p className="settings-card-note">{t("Agent 调用集成终端时使用此 Shell；默认安全策略下，每条命令执行前都需要审批。")}</p>
                  <div className="terminal-shell-test-row">
                    <button
                      className="secondary-button"
                      disabled={!onTestTerminalShell || testingTerminalShell}
                      onClick={() => void testTerminalShell()}
                      type="button"
                    >
                      <Icon name="tool" size={14} /> {testingTerminalShell ? t("测试中…") : t("测试 Shell")}
                    </button>
                    {terminalShellTest && (
                      <span className={terminalShellTest.ok ? 'is-success' : 'is-error'}>
                        {terminalShellTest.message}
                        {terminalShellTest.ok && <small> · {terminalShellTest.platform} · {terminalShellTest.latencyMs}ms</small>}
                      </span>
                    )}
                  </div>
                </section>
                <section className="settings-card context-policy-card">
                  <h3>{t("网络代理")}</h3>
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
                        <strong>{t('common.off')}<em>{t("默认")}</em></strong>
                        <small>{t("直连所有供应商，不经过代理。")}</small>
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
                        <strong>{t("自定义代理")}</strong>
                        <small>{t("转发所有模型请求；本地代理可用 http，远程代理请使用 https。")}</small>
                      </span>
                    </button>
                  </div>
                  {preferenceDraft.proxy.mode === 'custom' && (
                    <label className="system-prompt-field">
                      <FieldLabel hint={t("支持 http://（仅本机）与 https://，可在地址中包含用户名密码")}>{t("代理地址")}</FieldLabel>
                      <input
                        className="mono-input"
                        placeholder={t("例如：http://127.0.0.1:7890")}
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
  )
}
