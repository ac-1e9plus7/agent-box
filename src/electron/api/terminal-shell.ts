import { spawn } from 'node:child_process'
import { basename } from 'node:path'
import type { DeveloperRuntimeSettings, IntegratedTerminalShellConfig, TerminalShellTestResult } from '../../shared/types'
import { buildDeveloperEnvironment } from './runtime-environments'
import { getLanguage, t } from '../../shared/i18n'

export type TerminalShellKind = 'powershell' | 'cmd' | 'posix' | 'fish' | 'custom'

export interface ResolvedTerminalShell {
  executable: string
  launchArgs: string[]
  kind: TerminalShellKind
  displayName: string
}

export interface TerminalCommandResult {
  result: string
  isError: boolean
  truncated?: boolean
  shell: ResolvedTerminalShell
}

const MAX_COMMAND_CHARACTERS = 100_000
const MAX_OUTPUT_CHARACTERS = 500_000
const MIN_TIMEOUT_MS = 500
const MAX_TIMEOUT_MS = 60_000

let automaticShellPromise: Promise<ResolvedTerminalShell | undefined> | undefined

export function automaticShellCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ResolvedTerminalShell[] {
  const candidates: ResolvedTerminalShell[] = []
  if (platform === 'win32') {
    candidates.push(
      { executable: 'pwsh.exe', launchArgs: ['-NoLogo', '-NoProfile'], kind: 'powershell', displayName: 'PowerShell 7' },
      { executable: 'powershell.exe', launchArgs: ['-NoLogo', '-NoProfile'], kind: 'powershell', displayName: 'Windows PowerShell' },
    )
    const comSpec = env.ComSpec || env.COMSPEC
    if (comSpec) candidates.push({ executable: comSpec, launchArgs: ['/d', '/q'], kind: 'cmd', displayName: 'Command Prompt' })
    candidates.push({ executable: 'cmd.exe', launchArgs: ['/d', '/q'], kind: 'cmd', displayName: 'Command Prompt' })
    return uniqueCandidates(candidates, platform)
  }

  const configuredShell = env.SHELL?.trim()
  if (configuredShell) candidates.push(shellFromExecutable(configuredShell, [], 'Environment SHELL'))
  if (platform === 'darwin') {
    candidates.push(
      { executable: '/bin/zsh', launchArgs: [], kind: 'posix', displayName: 'Z shell' },
      { executable: '/bin/bash', launchArgs: [], kind: 'posix', displayName: 'Bash' },
      { executable: '/bin/sh', launchArgs: [], kind: 'posix', displayName: 'POSIX shell' },
    )
  } else {
    candidates.push(
      { executable: '/bin/bash', launchArgs: [], kind: 'posix', displayName: 'Bash' },
      { executable: '/usr/bin/bash', launchArgs: [], kind: 'posix', displayName: 'Bash' },
      { executable: '/bin/zsh', launchArgs: [], kind: 'posix', displayName: 'Z shell' },
      { executable: '/usr/bin/fish', launchArgs: [], kind: 'fish', displayName: 'Fish' },
      { executable: '/bin/sh', launchArgs: [], kind: 'posix', displayName: 'POSIX shell' },
    )
  }
  return uniqueCandidates(candidates, platform)
}

export function commandArguments(shell: ResolvedTerminalShell, command: string): string[] {
  if (shell.launchArgs.some((argument) => argument.includes('{command}'))) {
    return shell.launchArgs.map((argument) => argument.replaceAll('{command}', command))
  }
  if (shell.kind === 'powershell') return [...shell.launchArgs, '-NonInteractive', '-Command', command]
  if (shell.kind === 'cmd') return [...shell.launchArgs, '/s', '/c', command]
  if (shell.kind === 'fish') return [...shell.launchArgs, '-c', command]
  return [...shell.launchArgs, '-lc', command]
}

export async function resolveIntegratedTerminalShell(
  config: IntegratedTerminalShellConfig,
): Promise<ResolvedTerminalShell | undefined> {
  if (config.mode === 'custom') {
    const shell = shellFromExecutable(config.executable.trim(), config.args, 'Custom shell')
    return await probeShell(shell) ? shell : undefined
  }
  automaticShellPromise ??= (async () => {
    for (const shell of automaticShellCandidates(process.platform, process.env)) {
      if (await probeShell(shell)) return shell
    }
    return undefined
  })()
  return automaticShellPromise
}

export async function executeTerminalCommand(
  config: IntegratedTerminalShellConfig,
  command: string,
  options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal; developerRuntimes?: DeveloperRuntimeSettings } = {},
): Promise<TerminalCommandResult> {
  const shell = await resolveIntegratedTerminalShell(config)
  const fallbackShell = config.mode === 'custom'
    ? shellFromExecutable(config.executable.trim() || t("(未配置)"), config.args, 'Custom shell')
    : { executable: t("(未找到)"), launchArgs: [], kind: 'custom' as const, displayName: 'Auto shell' }
  if (!shell) {
    return {
      result: config.mode === 'custom'
        ? t("无法启动指定 Shell：{value0}。请检查可执行文件路径和启动参数。", { value0: config.executable || '(空)' })
        : t("未找到可用的集成终端 Shell。Windows 请安装 PowerShell 或确认 cmd.exe 可用；macOS/Linux 请配置 SHELL 或安装 bash/zsh/sh。"),
      isError: true,
      shell: fallbackShell,
    }
  }
  if (!command.trim()) return { result: t("终端命令不能为空。"), isError: true, shell }
  if (command.length > MAX_COMMAND_CHARACTERS) {
    return { result: t("终端命令超过 {value0} 字符限制。", { value0: MAX_COMMAND_CHARACTERS.toLocaleString(getLanguage()) }), isError: true, shell }
  }
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, options.timeoutMs ?? 20_000))
  const runtimeSettings = options.developerRuntimes
  const environment = runtimeSettings
    ? await buildDeveloperEnvironment(runtimeSettings, options.cwd, process.env)
    : process.env
  const execution = await runShellProcess(shell, command, timeoutMs, options.cwd, options.signal, environment)
  return { ...execution, shell }
}

export async function testIntegratedTerminalShell(
  config: IntegratedTerminalShellConfig,
): Promise<TerminalShellTestResult> {
  const startedAt = performance.now()
  const shell = await resolveIntegratedTerminalShell(config)
  if (!shell) {
    return {
      ok: false,
      platform: process.platform,
      latencyMs: Math.round(performance.now() - startedAt),
      message: config.mode === 'custom'
        ? t("无法启动指定 Shell：{value0}", { value0: config.executable || '(空)' })
        : t("当前操作系统没有探测到可用 Shell。"),
    }
  }
  return {
    ok: true,
    platform: process.platform,
    displayName: shell.displayName,
    executable: shell.executable,
    latencyMs: Math.round(performance.now() - startedAt),
    message: t("已连接 {value0}（{value1}）", { value0: shell.displayName, value1: shell.executable }),
  }
}

function shellFromExecutable(executable: string, args: string[], fallbackName: string): ResolvedTerminalShell {
  const fileName = basename(executable).toLowerCase().replace(/\.exe$/, '')
  if (fileName === 'pwsh') return { executable, launchArgs: [...args], kind: 'powershell', displayName: 'PowerShell 7' }
  if (fileName === 'powershell') return { executable, launchArgs: [...args], kind: 'powershell', displayName: 'Windows PowerShell' }
  if (fileName === 'cmd') return { executable, launchArgs: [...args], kind: 'cmd', displayName: 'Command Prompt' }
  if (fileName === 'fish') return { executable, launchArgs: [...args], kind: 'fish', displayName: 'Fish' }
  if (['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(fileName)) {
    return { executable, launchArgs: [...args], kind: 'posix', displayName: fileName === 'zsh' ? 'Z shell' : fileName === 'bash' ? 'Bash' : 'POSIX shell' }
  }
  return { executable, launchArgs: [...args], kind: 'custom', displayName: fallbackName }
}

function uniqueCandidates(candidates: ResolvedTerminalShell[], platform: NodeJS.Platform): ResolvedTerminalShell[] {
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = platform === 'win32' ? candidate.executable.toLowerCase() : candidate.executable
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function probeShell(shell: ResolvedTerminalShell): Promise<boolean> {
  const probeCommand = shell.kind === 'cmd' ? 'exit /b 0' : 'exit 0'
  const result = await runShellProcess(shell, probeCommand, 2_000)
  return !result.isError
}

function runShellProcess(
  shell: ResolvedTerminalShell,
  command: string,
  timeoutMs: number,
  cwd?: string,
  signal?: AbortSignal,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Omit<TerminalCommandResult, 'shell'>> {
  return new Promise((resolve) => {
    const child = spawn(shell.executable, commandArguments(shell, command), {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sanitizedTerminalEnvironment(environment),
    })
    let settled = false
    let output = ''
    let truncated = false
    const append = (chunk: Buffer) => {
      if (output.length >= MAX_OUTPUT_CHARACTERS) {
        truncated = true
        return
      }
      const text = chunk.toString('utf8')
      const remaining = MAX_OUTPUT_CHARACTERS - output.length
      output += text.slice(0, remaining)
      if (text.length > remaining) truncated = true
    }
    const finish = (result: Omit<TerminalCommandResult, 'shell'>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const onAbort = () => {
      child.kill()
      finish({ result: t("终端命令已取消。"), isError: true })
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({
        result: t("终端命令超过 {value0} 秒，已终止。\n{value1}{value2}", { value0: (timeoutMs / 1_000).toFixed(1), value1: output, value2: truncated ? '\n[输出已截断]' : '' }).trim(),
        isError: true,
        truncated,
      })
    }, timeoutMs)
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.once('error', (error) => finish({ result: error.message, isError: true }))
    child.once('close', (code) => finish({
      result: output.trim()
        ? `${output.trim()}${truncated ? t("\n[输出已截断]") : ''}`
        : t("(Shell 退出码 {value0}，无输出)", { value0: code ?? 'unknown' }),
      isError: code !== 0,
      truncated,
    }))
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function sanitizedTerminalEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sensitiveName = /(token|secret|password|passwd|api[_-]?key|authorization|credential|cookie|private[_-]?key)/i
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !sensitiveName.test(name)),
  )
}
