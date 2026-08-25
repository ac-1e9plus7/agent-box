import { isAbsolute } from 'node:path'
import type {
  AppSettings,
  DeveloperRuntimeSettings,
  IntegratedTerminalShellConfig,
  ProxyConfig,
} from '../../shared/types'
import { normalizeAgentToolTurnLimit } from '../../shared/agent-limits'
import { MAX_USER_AVATAR_DATA_URL_LENGTH, MAX_USER_NICKNAME_LENGTH } from '../../shared/user-profile'
import { isLoopbackUrl } from '../api/provider-policy'
import { normalizeRuntimePathInput } from '../runtime-path'
import { isAppLanguage, type AppLanguage } from '../../shared/i18n'
import { t } from '../../shared/i18n'

/**
 * Validates settings and fills fields introduced after vault schema v1.
 * Missing contextManagementMode is intentionally migrated to the safe,
 * non-destructive manual behavior.
 */
export function normalizeAppSettings(value: unknown, fallbackLanguage: AppLanguage = 'en-US'): AppSettings {
  if (!isRecord(value)) throw new Error('Invalid settings')
  const language = value.language ?? fallbackLanguage
  if (!isAppLanguage(language)) throw new Error('Invalid language')
  if (!['system', 'light', 'dark'].includes(String(value.theme))) {
    throw new Error('Invalid theme')
  }
  if (!['enter', 'mod-enter'].includes(String(value.sendShortcut))) {
    throw new Error('Invalid send shortcut')
  }
  const contextManagementMode = value.contextManagementMode ?? 'manual'
  if (!['manual', 'auto'].includes(String(contextManagementMode))) {
    throw new Error('Invalid context management mode')
  }
  if (typeof value.defaultReasoningEnabled !== 'boolean') {
    throw new Error('Invalid reasoning setting')
  }
  if (!['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(value.defaultReasoningEffort))) {
    throw new Error('Invalid reasoning effort')
  }
  if (typeof value.systemPrompt !== 'string' || value.systemPrompt.length > 100_000) {
    throw new Error('Invalid system prompt')
  }
  const userNickname = normalizeUserNickname(value.userNickname)
  const userAvatar = normalizeUserAvatar(value.userAvatar)
  if (value.defaultModelId !== undefined && typeof value.defaultModelId !== 'string') {
    throw new Error('Invalid default model')
  }
  if (value.titleGenerationModelId !== undefined && typeof value.titleGenerationModelId !== 'string') {
    throw new Error('Invalid title generation model')
  }
  if (value.defaultAgentMode !== undefined && typeof value.defaultAgentMode !== 'boolean') {
    throw new Error('Invalid default agent mode')
  }
  const agentToolTurnLimit = normalizeAgentToolTurnLimit(value.agentToolTurnLimit)
  if (value.mcpEnabled !== undefined && typeof value.mcpEnabled !== 'boolean') {
    throw new Error('Invalid MCP enabled setting')
  }
  const mcpToolRetrievalMode = value.mcpToolRetrievalMode ?? 'auto'
  if (!['auto', 'all'].includes(String(mcpToolRetrievalMode))) {
    throw new Error('Invalid MCP tool retrieval mode')
  }
  const storedApprovalPolicy = value.mcpToolApprovalPolicy ?? 'sensitive'
  if (!['always', 'sensitive', 'never', 'full-access'].includes(String(storedApprovalPolicy))) {
    throw new Error('Invalid MCP tool approval policy')
  }
  const mcpToolApprovalPolicy = storedApprovalPolicy === 'never' ? 'full-access' : storedApprovalPolicy
  const toolApprovalTimeoutMode = value.toolApprovalTimeoutMode ?? 'five-minutes'
  if (!['five-minutes', 'never'].includes(String(toolApprovalTimeoutMode))) {
    throw new Error('Invalid tool approval timeout mode')
  }
  const proxy = normalizeProxy(value.proxy)
  const integratedTerminalShell = normalizeIntegratedTerminalShell(value.integratedTerminalShell)
  const developerRuntimes = normalizeDeveloperRuntimes(value.developerRuntimes)
  const defaultWorkingDirectory = normalizeOptionalDirectory(value.defaultWorkingDirectory, 'default working directory')
  const settings: AppSettings = {
    language,
    theme: value.theme as AppSettings['theme'],
    sendShortcut: value.sendShortcut as AppSettings['sendShortcut'],
    contextManagementMode: contextManagementMode as AppSettings['contextManagementMode'],
    userNickname,
    userAvatar,
    defaultModelId: value.defaultModelId,
    defaultReasoningEnabled: value.defaultReasoningEnabled,
    defaultReasoningEffort: value.defaultReasoningEffort as AppSettings['defaultReasoningEffort'],
    defaultAgentMode: Boolean(value.defaultAgentMode),
    agentToolTurnLimit,
    mcpEnabled: value.mcpEnabled !== undefined ? Boolean(value.mcpEnabled) : true,
    mcpToolRetrievalMode: mcpToolRetrievalMode as AppSettings['mcpToolRetrievalMode'],
    mcpToolApprovalPolicy: mcpToolApprovalPolicy as AppSettings['mcpToolApprovalPolicy'],
    toolApprovalTimeoutMode: toolApprovalTimeoutMode as AppSettings['toolApprovalTimeoutMode'],
    systemPrompt: value.systemPrompt,
    proxy,
    integratedTerminalShell,
    defaultWorkingDirectory,
    developerRuntimes,
  }
  if (value.titleGenerationModelId !== undefined) {
    settings.titleGenerationModelId = value.titleGenerationModelId
  }
  return settings
}

function normalizeUserNickname(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string' || value.length > MAX_USER_NICKNAME_LENGTH || /[\r\n\0]/.test(value)) {
    throw new Error(t('Nickname cannot exceed 50 characters or contain line breaks.'))
  }
  return value.trim()
}

function normalizeUserAvatar(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string' || value.length > MAX_USER_AVATAR_DATA_URL_LENGTH) {
    throw new Error(t('The avatar data is too large or the format is invalid.'))
  }
  const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
  const payload = match?.[1]
  if (!payload || payload.length % 4 !== 0) throw new Error(t('The avatar data is too large or the format is invalid.'))
  return value
}

export function defaultDeveloperRuntimeSettings(): DeveloperRuntimeSettings {
  return {
    jdk: { mode: 'auto', home: '' },
    go: { mode: 'auto', executable: '', root: '' },
    php: { mode: 'auto', executable: '' },
    python: { mode: 'auto', executable: '', environment: '', condaExecutable: 'conda' },
  }
}

export function normalizeDeveloperRuntimes(value: unknown): DeveloperRuntimeSettings {
  if (value === undefined || value === null) return defaultDeveloperRuntimeSettings()
  if (!isRecord(value)) throw new Error('Invalid developer runtimes')
  const defaults = defaultDeveloperRuntimeSettings()
  const jdk = normalizeRuntimeRecord(value.jdk, defaults.jdk, ['home'])
  const go = normalizeRuntimeRecord(value.go, defaults.go, ['executable', 'root'])
  const php = normalizeRuntimeRecord(value.php, defaults.php, ['executable'])
  if (!isRecord(value.python)) throw new Error('Invalid Python runtime')
  const pythonMode = String(value.python.mode ?? 'auto')
  if (!['auto', 'system', 'venv', 'conda', 'custom'].includes(pythonMode)) {
    throw new Error('Invalid Python runtime mode')
  }
  const python = {
    mode: pythonMode as DeveloperRuntimeSettings['python']['mode'],
    executable: normalizeRuntimePathInput(value.python.executable ?? ''),
    environment: normalizeRuntimePathInput(value.python.environment ?? ''),
    condaExecutable: normalizeRuntimePathInput(value.python.condaExecutable ?? 'conda') || 'conda',
  }
  if (python.mode === 'venv' && !python.environment) throw new Error(t('Python venv path cannot be empty.'))
  if (python.mode === 'conda' && !python.environment)
    throw new Error(t('Conda environment name or path cannot be empty.'))
  if (python.mode === 'custom' && !python.executable) throw new Error(t('Python executable cannot be empty.'))
  return { jdk, go, php, python }
}

function normalizeRuntimeRecord<T extends { mode: 'auto' | 'custom' }>(
  value: unknown,
  defaults: T,
  fields: Array<Exclude<keyof T, 'mode'>>,
): T {
  if (value === undefined || value === null) return { ...defaults }
  if (!isRecord(value)) throw new Error('Invalid developer runtime')
  const mode = String(value.mode ?? 'auto')
  if (mode !== 'auto' && mode !== 'custom') throw new Error('Invalid developer runtime mode')
  const result = { ...defaults, mode }
  for (const field of fields) result[field] = normalizeRuntimePathInput(value[String(field)] ?? '') as T[typeof field]
  if (mode === 'custom' && fields.every((field) => !String(result[field] || '').trim())) {
    throw new Error(t('Custom runtime path cannot be empty.'))
  }
  return result
}

function normalizeOptionalDirectory(value: unknown, label: string): string {
  if (value === undefined || value === null || value === '') return ''
  const directory = normalizeRuntimePathInput(value)
  if (!isAbsolute(directory)) throw new Error(`Invalid ${label}`)
  return directory
}

export function normalizeIntegratedTerminalShell(value: unknown): IntegratedTerminalShellConfig {
  if (value === undefined || value === null) return { mode: 'auto', executable: '', args: [] }
  if (!isRecord(value)) throw new Error('Invalid integrated terminal shell')
  const mode = value.mode === undefined ? 'auto' : String(value.mode)
  if (mode !== 'auto' && mode !== 'custom') throw new Error('Invalid integrated terminal shell mode')
  if (typeof value.executable !== 'string' || value.executable.length > 2_000 || /[\r\n\0]/.test(value.executable)) {
    throw new Error('Invalid integrated terminal shell executable')
  }
  if (!Array.isArray(value.args) || value.args.length > 64) {
    throw new Error('Invalid integrated terminal shell arguments')
  }
  const args = value.args.map((argument) => {
    if (typeof argument !== 'string' || argument.length > 4_096 || argument.includes('\0')) {
      throw new Error('Invalid integrated terminal shell argument')
    }
    return argument
  })
  const executable = value.executable.trim()
  if (mode === 'custom' && !executable) throw new Error(t('Custom terminal shell executable cannot be empty.'))
  return { mode: mode, executable, args }
}

/**
 * Proxy config is filled with a safe disabled default for older vaults that
 * predate the field. Only `custom` mode enforces a valid URL; `off` keeps any
 * stored URL verbatim so toggling the setting does not lose user input.
 */
function normalizeProxy(value: unknown): ProxyConfig {
  if (value === undefined || value === null) return { mode: 'off', url: '' }
  if (!isRecord(value)) throw new Error('Invalid proxy')
  const mode = value.mode === undefined ? 'off' : String(value.mode)
  if (mode !== 'off' && mode !== 'custom') throw new Error('Invalid proxy mode')
  if (typeof value.url !== 'string') throw new Error('Invalid proxy URL')
  if (value.url.length > 2_000) throw new Error('Invalid proxy URL')
  if (mode === 'custom') validateProxyUrl(value.url)
  return { mode: mode, url: value.url }
}

function validateProxyUrl(url: string): void {
  if (!url.trim()) throw new Error(t('The proxy address cannot be empty.'))
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(t('The proxy address format is invalid.'))
  }
  const scheme = parsed.protocol.toLowerCase()
  if (scheme !== 'http:' && scheme !== 'https:') {
    throw new Error(t('The proxy address only supports http and https protocols.'))
  }
  // Remote HTTP proxies would transmit requests in the clear; require HTTPS for
  // non-loopback hosts, mirroring the provider base-URL policy.
  if (scheme === 'http:' && !isLoopbackUrl(url)) {
    throw new Error(t('Remote HTTP proxies are not allowed. Use an HTTPS proxy.'))
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
