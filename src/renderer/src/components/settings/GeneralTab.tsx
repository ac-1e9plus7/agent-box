import type { Dispatch, JSX, SetStateAction } from 'react'
import type { TerminalShellTestResult } from '../../../../shared/types'
import type { AppPreferences, ModelConfig } from '../../types'
import { DEFAULT_AGENT_TOOL_TURN_LIMIT } from '../../../../shared/agent-limits'
import {
  DEFAULT_AGENT_CONTEXT_COMPACTION_KEEP_RECENT_TURNS,
  DEFAULT_AGENT_CONTEXT_COMPACTION_THRESHOLD_PERCENT,
  DEFAULT_AGENT_DYNAMIC_TOOL_LIMIT,
  DEFAULT_AGENT_TOOL_RESULT_MAX_CHARACTERS,
  MAX_AGENT_CONTEXT_COMPACTION_KEEP_RECENT_TURNS,
  MAX_AGENT_CONTEXT_COMPACTION_THRESHOLD_PERCENT,
  MAX_AGENT_DYNAMIC_TOOL_LIMIT,
  MAX_AGENT_TOOL_RESULT_MAX_CHARACTERS,
  MIN_AGENT_CONTEXT_COMPACTION_KEEP_RECENT_TURNS,
  MIN_AGENT_CONTEXT_COMPACTION_THRESHOLD_PERCENT,
  MIN_AGENT_DYNAMIC_TOOL_LIMIT,
  MIN_AGENT_TOOL_RESULT_MAX_CHARACTERS,
} from '../../../../shared/agent-token-optimization'
import { MAX_USER_NICKNAME_LENGTH } from '../../../../shared/user-profile'
import { t } from '../../../../shared/i18n'
import { Icon } from '../Icon'
import { AgentTurnLimitInput, BoundedNumberInput, FieldLabel, SettingsToggle } from './SettingsControls'

interface GeneralTabProps {
  avatarInputError: string
  chooseDirectory: (current?: string) => Promise<string | undefined>
  hasTestTerminalShellHandler: boolean
  models: ModelConfig[]
  preferenceDraft: AppPreferences
  selectAvatarFile: (file: File | undefined) => void
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
  setPreferenceDraft,
  terminalShellTest,
  testTerminalShell,
  testingTerminalShell,
}: GeneralTabProps): JSX.Element {
  return (
    <div className="settings-section-content narrow-settings">
      <section className="settings-card user-profile-card">
        <h3>{t('Profile')}</h3>
        <div className="user-profile-settings">
          <div className={`user-profile-avatar-preview ${preferenceDraft.userAvatar ? 'has-image' : ''}`}>
            {preferenceDraft.userAvatar ? (
              <img alt={t('Current avatar')} src={preferenceDraft.userAvatar} />
            ) : (
              <Icon name="user" size={28} />
            )}
          </div>
          <div className="user-profile-fields">
            <label>
              <FieldLabel
                hint={t('Maximum {value0} characters, can be left blank', { value0: MAX_USER_NICKNAME_LENGTH })}
              >
                {t('Nickname')}
              </FieldLabel>
              <input
                maxLength={MAX_USER_NICKNAME_LENGTH}
                onChange={(event) =>
                  setPreferenceDraft((current) => ({
                    ...current,
                    userNickname: event.target.value,
                  }))
                }
                placeholder={t('Name shown in the app')}
                type="text"
                value={preferenceDraft.userNickname ?? ''}
              />
            </label>
            <div className="user-profile-avatar-actions">
              <label className="secondary-button">
                <Icon name="image" size={14} />
                {preferenceDraft.userAvatar ? t('Change avatar') : t('Select avatar')}
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
                >
                  {t('Remove')}
                </button>
              )}
            </div>
          </div>
        </div>
        <p className="user-profile-note">
          <Icon name="shield" size={13} />
          {t(
            'Your nickname and avatar are shown only in the local interface. They are never added to prompts or sent to a model.',
          )}
        </p>
        {avatarInputError && (
          <p className="user-profile-error" role="alert">
            {avatarInputError}
          </p>
        )}
      </section>
      <section className="settings-card">
        <h3>{t('Built-in browser')}</h3>
        <div className="settings-row">
          <div>
            <strong>{t('Enable the isolated built-in browser')}</strong>
            <small>
              {t(
                'Remote pages run without Node.js or AgentBox IPC. Browser tools remain disabled until enabled for an individual conversation.',
              )}
            </small>
          </div>
          <SettingsToggle
            checked={preferenceDraft.builtInBrowserEnabled}
            label={t('Enable the isolated built-in browser')}
            onChange={(builtInBrowserEnabled) =>
              setPreferenceDraft((current) => ({ ...current, builtInBrowserEnabled }))
            }
          />
        </div>
        {preferenceDraft.builtInBrowserEnabled && (
          <>
            <div className="settings-row">
              <div>
                <strong>{t('Persist browser cookies')}</strong>
                <small>
                  {t(
                    'Encrypt cookies in the Vault and restore them only for the same conversation. Turning this off deletes all stored browser cookies.',
                  )}
                </small>
              </div>
              <SettingsToggle
                checked={preferenceDraft.browserPersistCookiesEnabled}
                label={t('Persist browser cookies')}
                onChange={(browserPersistCookiesEnabled) =>
                  setPreferenceDraft((current) => ({ ...current, browserPersistCookiesEnabled }))
                }
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>{t('Allow Agent browser screenshots')}</strong>
                <small>{t('Allow approved screenshots to be sent to vision-capable model APIs.')}</small>
              </div>
              <SettingsToggle
                checked={preferenceDraft.browserAgentScreenshotsEnabled}
                label={t('Allow Agent browser screenshots')}
                onChange={(browserAgentScreenshotsEnabled) =>
                  setPreferenceDraft((current) => ({ ...current, browserAgentScreenshotsEnabled }))
                }
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>{t('Allow browser file uploads')}</strong>
                <small>{t('Allow approved Agent uploads from the conversation working directory only.')}</small>
              </div>
              <SettingsToggle
                checked={preferenceDraft.browserFileUploadsEnabled}
                label={t('Allow browser file uploads')}
                onChange={(browserFileUploadsEnabled) =>
                  setPreferenceDraft((current) => ({ ...current, browserFileUploadsEnabled }))
                }
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>{t('Allow browser downloads')}</strong>
                <small>
                  {t(
                    'Allow approved Agent downloads into the conversation working directory and manual downloads into the system Downloads folder.',
                  )}
                </small>
              </div>
              <SettingsToggle
                checked={preferenceDraft.browserDownloadsEnabled}
                label={t('Allow browser downloads')}
                onChange={(browserDownloadsEnabled) =>
                  setPreferenceDraft((current) => ({ ...current, browserDownloadsEnabled }))
                }
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>{t('Allow HTTP loopback pages')}</strong>
                <small>
                  {t('Allow explicitly approved http://localhost and loopback URLs for local web development only.')}
                </small>
              </div>
              <SettingsToggle
                checked={preferenceDraft.browserAllowHttpLoopback}
                label={t('Allow HTTP loopback pages')}
                onChange={(browserAllowHttpLoopback) =>
                  setPreferenceDraft((current) => ({ ...current, browserAllowHttpLoopback }))
                }
              />
            </div>
          </>
        )}
        <p className="settings-card-note">
          {t(
            'Browser sessions and site storage are temporary. When Cookie persistence is enabled, accepted cookies are encrypted in the Vault; approved text and screenshot results remain in encrypted conversation history.',
          )}
        </p>
      </section>
      <section className="settings-card">
        <h3>{t('Appearance and behavior')}</h3>
        <div className="settings-row">
          <div>
            <strong>{t('Display language')}</strong>
            <small>{t('Change the language used by AgentBox and system dialogs')}</small>
          </div>
          <select
            aria-label={t('Display language')}
            value={preferenceDraft.language}
            onChange={(event) =>
              setPreferenceDraft((current) => ({
                ...current,
                language: event.target.value as AppPreferences['language'],
              }))
            }
          >
            <option value="zh-CN">{t('Simplified Chinese')}</option>
            <option value="en-US">{t('English')}</option>
          </select>
        </div>
        <div className="settings-row">
          <div>
            <strong>{t('Theme')}</strong>
            <small>{t('Use the system theme or choose a fixed theme')}</small>
          </div>
          <div className="segmented-control">
            {(['system', 'light', 'dark'] as const).map((theme) => (
              <button
                className={preferenceDraft.theme === theme ? 'is-active' : ''}
                key={theme}
                onClick={() => setPreferenceDraft((current) => ({ ...current, theme }))}
              >
                {theme === 'system' ? t('Use system setting') : theme === 'light' ? t('Light') : t('Dark')}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-row">
          <div>
            <strong>{t('Default Agent mode for new conversations')}</strong>
            <small>
              {t('Agent mode and skill injection are enabled by default when creating a new conversation.')}
            </small>
          </div>
          <SettingsToggle
            checked={Boolean(preferenceDraft.defaultAgentMode)}
            label={t('Default Agent mode for new conversations')}
            onChange={(defaultAgentMode) => setPreferenceDraft((current) => ({ ...current, defaultAgentMode }))}
          />
        </div>
        <div className="settings-row">
          <div>
            <strong>{t('agent.toolCallTurns')}</strong>
            <small>
              {t('Range: 1–100. Default: {value0}. Higher limits increase latency and API costs.', {
                value0: DEFAULT_AGENT_TOOL_TURN_LIMIT,
              })}
            </small>
          </div>
          <AgentTurnLimitInput
            onChange={(agentToolTurnLimit) => setPreferenceDraft((current) => ({ ...current, agentToolTurnLimit }))}
            value={preferenceDraft.agentToolTurnLimit ?? DEFAULT_AGENT_TOOL_TURN_LIMIT}
          />
        </div>
        <div className="settings-row">
          <div>
            <strong>{t('Default reasoning for new conversations')}</strong>
            <small>{t('Reasoning will be enabled automatically for models that support it')}</small>
          </div>
          <SettingsToggle
            checked={preferenceDraft.defaultReasoningEnabled}
            label={t('Default reasoning for new conversations')}
            onChange={(defaultReasoningEnabled) =>
              setPreferenceDraft((current) => ({ ...current, defaultReasoningEnabled }))
            }
          />
        </div>
        <div className="settings-row">
          <div>
            <strong>{t('Default reasoning effort for new models')}</strong>
            <small>
              {t(
                'It is used as the default initial value when adding a model and can be adjusted individually on the model page.',
              )}
            </small>
          </div>
          <select
            value={preferenceDraft.defaultReasoningEffort}
            onChange={(event) =>
              setPreferenceDraft((current) => ({
                ...current,
                defaultReasoningEffort: event.target.value as AppPreferences['defaultReasoningEffort'],
              }))
            }
          >
            <option value="minimal">{t('Minimal')}</option>
            <option value="low">{t('Low')}</option>
            <option value="medium">{t('Medium')}</option>
            <option value="high">{t('High')}</option>
            <option value="xhigh">{t('Extra high (xhigh)')}</option>
            <option value="max">{t('Maximum (max)')}</option>
          </select>
        </div>
      </section>
      <section className="settings-card">
        <h3>{t('Agent token optimization')}</h3>
        <div className="settings-row">
          <div>
            <strong>{t('Compact tool results sent to the model')}</strong>
            <small>
              {t('Keep complete tool output locally while limiting the text replayed to later model turns.')}
            </small>
          </div>
          <SettingsToggle
            checked={preferenceDraft.agentToolResultCompactionEnabled}
            label={t('Compact tool results sent to the model')}
            onChange={(agentToolResultCompactionEnabled) =>
              setPreferenceDraft((current) => ({ ...current, agentToolResultCompactionEnabled }))
            }
          />
        </div>
        {preferenceDraft.agentToolResultCompactionEnabled && (
          <div className="settings-row">
            <div>
              <strong>{t('Maximum model-visible tool-result characters')}</strong>
              <small>
                {t('Range: {minimum}–{maximum}. Default: {defaultValue}.', {
                  minimum: MIN_AGENT_TOOL_RESULT_MAX_CHARACTERS,
                  maximum: MAX_AGENT_TOOL_RESULT_MAX_CHARACTERS,
                  defaultValue: DEFAULT_AGENT_TOOL_RESULT_MAX_CHARACTERS,
                })}
              </small>
            </div>
            <BoundedNumberInput
              ariaLabel={t('Maximum model-visible tool-result characters')}
              maximum={MAX_AGENT_TOOL_RESULT_MAX_CHARACTERS}
              minimum={MIN_AGENT_TOOL_RESULT_MAX_CHARACTERS}
              onChange={(agentToolResultMaxCharacters) =>
                setPreferenceDraft((current) => ({ ...current, agentToolResultMaxCharacters }))
              }
              suffix={t('characters')}
              value={preferenceDraft.agentToolResultMaxCharacters}
            />
          </div>
        )}
        <div className="settings-row">
          <div>
            <strong>{t('Expose a smaller tool set dynamically')}</strong>
            <small>
              {t('Start Agent runs with a limited tool set and make additional tools available on demand.')}
            </small>
          </div>
          <SettingsToggle
            checked={preferenceDraft.agentDynamicToolExposureEnabled}
            label={t('Expose a smaller tool set dynamically')}
            onChange={(agentDynamicToolExposureEnabled) =>
              setPreferenceDraft((current) => ({ ...current, agentDynamicToolExposureEnabled }))
            }
          />
        </div>
        {preferenceDraft.agentDynamicToolExposureEnabled && (
          <div className="settings-row">
            <div>
              <strong>{t('Initial dynamic tool limit')}</strong>
              <small>
                {t('Range: {minimum}–{maximum}. Default: {defaultValue}.', {
                  minimum: MIN_AGENT_DYNAMIC_TOOL_LIMIT,
                  maximum: MAX_AGENT_DYNAMIC_TOOL_LIMIT,
                  defaultValue: DEFAULT_AGENT_DYNAMIC_TOOL_LIMIT,
                })}
              </small>
            </div>
            <BoundedNumberInput
              ariaLabel={t('Initial dynamic tool limit')}
              maximum={MAX_AGENT_DYNAMIC_TOOL_LIMIT}
              minimum={MIN_AGENT_DYNAMIC_TOOL_LIMIT}
              onChange={(agentDynamicToolLimit) =>
                setPreferenceDraft((current) => ({ ...current, agentDynamicToolLimit }))
              }
              suffix={t('tools')}
              value={preferenceDraft.agentDynamicToolLimit}
            />
          </div>
        )}
        <div className="settings-row">
          <div>
            <strong>{t('Load Skill resources only when needed')}</strong>
            <small>{t('Inject Skill entry instructions first, then load references and scripts on demand.')}</small>
          </div>
          <SettingsToggle
            checked={preferenceDraft.agentLazySkillResourcesEnabled}
            label={t('Load Skill resources only when needed')}
            onChange={(agentLazySkillResourcesEnabled) =>
              setPreferenceDraft((current) => ({ ...current, agentLazySkillResourcesEnabled }))
            }
          />
        </div>
        <div className="settings-row">
          <div>
            <strong>{t('Compact long-running Agent context')}</strong>
            <small>{t('Summarize older in-progress tool turns before the Agent fills the context window.')}</small>
          </div>
          <SettingsToggle
            checked={preferenceDraft.agentContextCompactionEnabled}
            label={t('Compact long-running Agent context')}
            onChange={(agentContextCompactionEnabled) =>
              setPreferenceDraft((current) => ({ ...current, agentContextCompactionEnabled }))
            }
          />
        </div>
        {preferenceDraft.agentContextCompactionEnabled && (
          <>
            <div className="settings-row">
              <div>
                <strong>{t('Context compaction threshold')}</strong>
                <small>
                  {t('Range: {minimum}%–{maximum}%. Default: {defaultValue}%.', {
                    minimum: MIN_AGENT_CONTEXT_COMPACTION_THRESHOLD_PERCENT,
                    maximum: MAX_AGENT_CONTEXT_COMPACTION_THRESHOLD_PERCENT,
                    defaultValue: DEFAULT_AGENT_CONTEXT_COMPACTION_THRESHOLD_PERCENT,
                  })}
                </small>
              </div>
              <BoundedNumberInput
                ariaLabel={t('Context compaction threshold')}
                maximum={MAX_AGENT_CONTEXT_COMPACTION_THRESHOLD_PERCENT}
                minimum={MIN_AGENT_CONTEXT_COMPACTION_THRESHOLD_PERCENT}
                onChange={(agentContextCompactionThresholdPercent) =>
                  setPreferenceDraft((current) => ({ ...current, agentContextCompactionThresholdPercent }))
                }
                suffix="%"
                value={preferenceDraft.agentContextCompactionThresholdPercent}
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>{t('Recent Agent turns to keep')}</strong>
                <small>
                  {t('Range: {minimum}–{maximum}. Default: {defaultValue}.', {
                    minimum: MIN_AGENT_CONTEXT_COMPACTION_KEEP_RECENT_TURNS,
                    maximum: MAX_AGENT_CONTEXT_COMPACTION_KEEP_RECENT_TURNS,
                    defaultValue: DEFAULT_AGENT_CONTEXT_COMPACTION_KEEP_RECENT_TURNS,
                  })}
                </small>
              </div>
              <BoundedNumberInput
                ariaLabel={t('Recent Agent turns to keep')}
                maximum={MAX_AGENT_CONTEXT_COMPACTION_KEEP_RECENT_TURNS}
                minimum={MIN_AGENT_CONTEXT_COMPACTION_KEEP_RECENT_TURNS}
                onChange={(agentContextCompactionKeepRecentTurns) =>
                  setPreferenceDraft((current) => ({ ...current, agentContextCompactionKeepRecentTurns }))
                }
                suffix={t('turns')}
                value={preferenceDraft.agentContextCompactionKeepRecentTurns}
              />
            </div>
          </>
        )}
        <label className="settings-row">
          <div>
            <strong>{t('Provider context reuse')}</strong>
            <small>
              {t(
                'Reuse stable prefixes or provider-native response state. Unsupported modes automatically fall back to prefix caching and then stateless replay.',
              )}
            </small>
            {['auto', 'native-continuation'].includes(preferenceDraft.agentProviderContextOptimizationMode) && (
              <small>
                {t(
                  'Native continuation may retain provider-side response state according to the provider’s data policy.',
                )}
              </small>
            )}
          </div>
          <select
            aria-label={t('Provider context reuse')}
            value={preferenceDraft.agentProviderContextOptimizationMode}
            onChange={(event) =>
              setPreferenceDraft((current) => ({
                ...current,
                agentProviderContextOptimizationMode: event.target
                  .value as AppPreferences['agentProviderContextOptimizationMode'],
              }))
            }
          >
            <option value="off">{t('Off (stateless replay)')}</option>
            <option value="auto">{t('Automatic fallback')}</option>
            <option value="prefix-cache">{t('Prefix caching')}</option>
            <option value="native-continuation">{t('Native continuation')}</option>
          </select>
        </label>
        <p className="settings-card-note">
          {t('All Agent token optimizations are disabled by default and can be enabled independently.')}
        </p>
      </section>
      <section className="settings-card">
        <h3>{t('Input')}</h3>
        <div className="settings-row">
          <div>
            <strong>{t('Press Enter to send')}</strong>
            <small>{t('Use ⌘/Ctrl + Enter to send after closing')}</small>
          </div>
          <SettingsToggle
            checked={preferenceDraft.sendShortcut === 'enter'}
            label={t('Press Enter to send')}
            onChange={(sendOnEnter) =>
              setPreferenceDraft((current) => ({
                ...current,
                sendShortcut: sendOnEnter ? 'enter' : 'mod-enter',
              }))
            }
          />
        </div>
        <label className="system-prompt-field">
          <FieldLabel hint={t('Added to every request; optional')}>{t('System prompt')}</FieldLabel>
          <textarea
            placeholder={t('For example: Please always answer in Simplified Chinese…')}
            rows={5}
            value={preferenceDraft.systemPrompt}
            onChange={(event) => setPreferenceDraft((current) => ({ ...current, systemPrompt: event.target.value }))}
          />
        </label>
        <div className="settings-row" style={{ marginTop: '16px' }}>
          <div>
            <strong>{t('Title generation model')}</strong>
            <small>{t('Model used to generate conversation titles automatically')}</small>
          </div>
          <select
            value={preferenceDraft.titleGenerationModelId ?? ''}
            onChange={(event) =>
              setPreferenceDraft((current) => ({
                ...current,
                titleGenerationModelId: event.target.value === '' ? undefined : event.target.value,
              }))
            }
          >
            <option value="">{t('Use the current conversation’s model')}</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
        </div>
      </section>
      <section className="settings-card">
        <h3>{t('Default working directory')}</h3>
        <div className="settings-row workspace-default-row">
          <div>
            <strong>{t('Default working directory')}</strong>
            <small>
              {t(
                'Shown as a shortcut in the New conversation dialog; you can still reuse an existing directory or choose another one',
              )}
            </small>
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
              <Icon name="folder" size={14} />
              {t('Select directory')}
            </button>
            {preferenceDraft.defaultWorkingDirectory && (
              <button
                className="icon-button"
                aria-label={t('Clear default working directory')}
                onClick={() => setPreferenceDraft((current) => ({ ...current, defaultWorkingDirectory: '' }))}
              >
                <Icon name="close" size={13} />
              </button>
            )}
          </div>
        </div>
        <p className="workspace-default-path" title={preferenceDraft.defaultWorkingDirectory}>
          {preferenceDraft.defaultWorkingDirectory ||
            t('Not set; choose a working directory when creating a conversation')}
        </p>
      </section>
      <section className="settings-card context-policy-card">
        <h3>{t('Context management')}</h3>
        <div className="context-policy-options">
          <button
            className={preferenceDraft.contextManagementMode === 'manual' ? 'is-active' : ''}
            onClick={() => setPreferenceDraft((current) => ({ ...current, contextManagementMode: 'manual' }))}
          >
            <span className="policy-radio">
              <i />
            </span>
            <span>
              <strong>
                {t('Manual management')}
                <em>{t('Default')}</em>
              </strong>
              <small>
                {t(
                  'Keep the full conversation history. Sending is blocked when it exceeds the model’s available context; shorten the conversation or adjust the context window.',
                )}
              </small>
            </span>
          </button>
          <button
            className={preferenceDraft.contextManagementMode === 'auto' ? 'is-active' : ''}
            onClick={() => setPreferenceDraft((current) => ({ ...current, contextManagementMode: 'auto' }))}
          >
            <span className="policy-radio">
              <i />
            </span>
            <span>
              <strong>{t('Automatic trimming')}</strong>
              <small>
                {t(
                  'When the limit is exceeded, trim complete user–assistant turns starting with the oldest. Always keep the system prompt and latest question.',
                )}
              </small>
            </span>
          </button>
        </div>
      </section>
      <section className="settings-card context-policy-card">
        <h3>{t('Integrated terminal shell')}</h3>
        <div className="context-policy-options">
          <button
            className={preferenceDraft.integratedTerminalShell.mode === 'auto' ? 'is-active' : ''}
            onClick={() =>
              setPreferenceDraft((current) => ({
                ...current,
                integratedTerminalShell: { ...current.integratedTerminalShell, mode: 'auto' },
              }))
            }
          >
            <span className="policy-radio">
              <i />
            </span>
            <span>
              <strong>
                {t('Auto-select')}
                <em>{t('Recommended')}</em>
              </strong>
              <small>
                {t(
                  'Windows tries PowerShell 7, Windows PowerShell, cmd in order; macOS/Linux uses SHELL first, then zsh, bash, fish or sh.',
                )}
              </small>
            </span>
          </button>
          <button
            className={preferenceDraft.integratedTerminalShell.mode === 'custom' ? 'is-active' : ''}
            onClick={() =>
              setPreferenceDraft((current) => ({
                ...current,
                integratedTerminalShell: { ...current.integratedTerminalShell, mode: 'custom' },
              }))
            }
          >
            <span className="policy-radio">
              <i />
            </span>
            <span>
              <strong>{t('Specify Shell')}</strong>
              <small>
                {t('Use the executable file name or absolute path, and add startup parameters line by line.')}
              </small>
            </span>
          </button>
        </div>
        {preferenceDraft.integratedTerminalShell.mode === 'custom' && (
          <div className="terminal-shell-fields">
            <label className="system-prompt-field">
              <FieldLabel
                hint={t('For example: pwsh.exe, C:\\Program Files\\PowerShell\\7\\pwsh.exe, /bin/zsh, /usr/bin/fish')}
              >
                {t('Shell executable')}
              </FieldLabel>
              <input
                className="mono-input"
                placeholder={t('Shell executable name or absolute path')}
                value={preferenceDraft.integratedTerminalShell.executable}
                onChange={(event) =>
                  setPreferenceDraft((current) => ({
                    ...current,
                    integratedTerminalShell: { ...current.integratedTerminalShell, executable: event.target.value },
                  }))
                }
              />
            </label>
            <label className="system-prompt-field">
              <FieldLabel
                hint={t(
                  'Enter one argument per line. Recognized shells receive the appropriate command arguments automatically; for other shells, use the {command} placeholder.',
                )}
              >
                {t('Startup parameters')}
              </FieldLabel>
              <textarea
                className="mono-input terminal-shell-args"
                placeholder={t('For example:\n-NoLogo\n-NoProfile')}
                value={preferenceDraft.integratedTerminalShell.args.join('\n')}
                onChange={(event) =>
                  setPreferenceDraft((current) => ({
                    ...current,
                    integratedTerminalShell: {
                      ...current.integratedTerminalShell,
                      args: event.target.value.split(/\r?\n/).filter((argument) => argument.length > 0),
                    },
                  }))
                }
              />
            </label>
          </div>
        )}
        <p className="settings-card-note">
          {t(
            'The Agent uses this shell for integrated terminal calls. Under the default security policy, every command requires approval before execution.',
          )}
        </p>
        <div className="terminal-shell-test-row">
          <button
            className="secondary-button"
            disabled={!onTestTerminalShell || testingTerminalShell}
            onClick={() => void testTerminalShell()}
            type="button"
          >
            <Icon name="tool" size={14} /> {testingTerminalShell ? t('Testing…') : t('Test shell')}
          </button>
          {terminalShellTest && (
            <span className={terminalShellTest.ok ? 'is-success' : 'is-error'}>
              {terminalShellTest.message}
              {terminalShellTest.ok && (
                <small>
                  {' '}
                  · {terminalShellTest.platform} · {terminalShellTest.latencyMs}ms
                </small>
              )}
            </span>
          )}
        </div>
      </section>
      <section className="settings-card context-policy-card">
        <h3>{t('Network proxy')}</h3>
        <div className="context-policy-options">
          <button
            className={preferenceDraft.proxy.mode === 'off' ? 'is-active' : ''}
            onClick={() =>
              setPreferenceDraft((current) => ({
                ...current,
                proxy: { ...current.proxy, mode: 'off' },
              }))
            }
          >
            <span className="policy-radio">
              <i />
            </span>
            <span>
              <strong>
                {t('Off')}
                <em>{t('Default')}</em>
              </strong>
              <small>{t('Connect directly to all providers without a proxy.')}</small>
            </span>
          </button>
          <button
            className={preferenceDraft.proxy.mode === 'custom' ? 'is-active' : ''}
            onClick={() =>
              setPreferenceDraft((current) => ({
                ...current,
                proxy: { ...current.proxy, mode: 'custom' },
              }))
            }
          >
            <span className="policy-radio">
              <i />
            </span>
            <span>
              <strong>{t('Custom proxy')}</strong>
              <small>
                {t('Forward all model requests; http is available for local proxies and https for remote proxies.')}
              </small>
            </span>
          </button>
        </div>
        {preferenceDraft.proxy.mode === 'custom' && (
          <label className="system-prompt-field">
            <FieldLabel
              hint={t(
                'Supports http:// (local machine only) and https://, username and password can be included in the address',
              )}
            >
              {t('Proxy address')}
            </FieldLabel>
            <input
              className="mono-input"
              placeholder={t('For example: http://127.0.0.1:7890')}
              value={preferenceDraft.proxy.url}
              onChange={(event) =>
                setPreferenceDraft((current) => ({
                  ...current,
                  proxy: { ...current.proxy, url: event.target.value },
                }))
              }
            />
          </label>
        )}
      </section>
    </div>
  )
}
