import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, posix, win32 } from 'node:path'
import type {
  CondaEnvironment,
  CondaEnvironmentListResult,
  DeveloperRuntimeKind,
  DeveloperRuntimeSettings,
  RuntimeTestResult,
} from '../../shared/types'
import { normalizeRuntimePathInput } from '../runtime-path'
import { t } from '../../shared/i18n'

export interface ResolvedRuntime {
  kind: DeveloperRuntimeKind
  executable: string
  prefixArgs: string[]
  version: string
  home?: string
  environmentPath?: string
  environmentType?: 'venv' | 'conda'
}

const runtimeCache = new Map<string, Promise<ResolvedRuntime | undefined>>()

export async function resolveDeveloperRuntime(
  kind: DeveloperRuntimeKind,
  settings: DeveloperRuntimeSettings,
  workingDirectory?: string,
): Promise<ResolvedRuntime | undefined> {
  const cacheKey = JSON.stringify([
    kind,
    settings[kind],
    kind === 'python' ? workingDirectory || '' : '',
    process.platform,
  ])
  let cached = runtimeCache.get(cacheKey)
  if (!cached) {
    cached = resolveRuntimeUncached(kind, settings, workingDirectory)
    if (runtimeCache.size >= 100) runtimeCache.clear()
    runtimeCache.set(cacheKey, cached)
  }
  return cached
}

export async function testDeveloperRuntime(
  kind: DeveloperRuntimeKind,
  settings: DeveloperRuntimeSettings,
  workingDirectory?: string,
): Promise<RuntimeTestResult> {
  const runtime = await resolveDeveloperRuntime(kind, settings, workingDirectory)
  return runtime
    ? {
        kind,
        ok: true,
        executable: runtime.executable,
        version: runtime.version,
        message: `${runtime.version} · ${runtime.executable}`,
      }
    : {
        kind,
        ok: false,
        message: t('No usable {value0} runtime was found. Check auto-detection or specify a path.', {
          value0: runtimeDisplayName(kind),
        }),
      }
}

export async function buildDeveloperEnvironment(
  settings: DeveloperRuntimeSettings,
  workingDirectory?: string,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const [jdk, go, php, python] = await Promise.all([
    resolveDeveloperRuntime('jdk', settings, workingDirectory),
    resolveDeveloperRuntime('go', settings, workingDirectory),
    resolveDeveloperRuntime('php', settings, workingDirectory),
    resolveDeveloperRuntime('python', settings, workingDirectory),
  ])
  const env = { ...baseEnvironment }
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH'
  const pathEntries: string[] = []
  for (const runtime of [jdk, go, php, python]) {
    if (runtime && isAbsolute(runtime.executable)) pathEntries.push(dirname(runtime.executable))
  }
  setRuntimeRootEnvironment(env, 'JAVA_HOME', jdk?.home)
  setRuntimeRootEnvironment(env, 'GOROOT', go?.home)
  if (python?.environmentPath) {
    if (python.environmentType === 'conda') {
      env.CONDA_PREFIX = python.environmentPath
    } else {
      env.VIRTUAL_ENV = python.environmentPath
    }
  }
  env[pathKey] = [...new Set(pathEntries), env[pathKey] || '']
    .filter(Boolean)
    .join(process.platform === 'win32' ? ';' : ':')
  return env
}

function setRuntimeRootEnvironment(
  environment: NodeJS.ProcessEnv,
  key: 'JAVA_HOME' | 'GOROOT',
  value: string | undefined,
): void {
  for (const existingKey of Object.keys(environment)) {
    if (existingKey.toLowerCase() === key.toLowerCase()) delete environment[existingKey]
  }
  if (value) environment[key] = value
}

export function pythonExecutableInEnvironment(environmentPath: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? win32.join(environmentPath, 'Scripts', 'python.exe')
    : posix.join(environmentPath, 'bin', 'python')
}

export function pythonExecutableInCondaEnvironment(environmentPath: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? win32.join(environmentPath, 'python.exe') : posix.join(environmentPath, 'bin', 'python')
}

export async function listCondaEnvironments(condaExecutableInput: string): Promise<CondaEnvironmentListResult> {
  const condaExecutable = normalizeRuntimePathInput(condaExecutableInput || 'conda') || 'conda'
  const result = await captureProcess(condaExecutable, ['env', 'list', '--json'], 5_000)
  if (!result.ok) {
    const detail = result.output.split(/\r?\n/).find(Boolean)?.trim()
    return {
      ok: false,
      condaExecutable,
      environments: [],
      message: detail
        ? t('Unable to read Conda environment: {value0}', { value0: detail })
        : t('No usable Conda executable was found.'),
    }
  }

  try {
    const environments = parseCondaEnvironments(result.stdout || result.output, process.platform)
    return {
      ok: true,
      condaExecutable,
      environments,
      message:
        environments.length > 0
          ? t('{value0} Conda environments found.', { value0: environments.length })
          : t('Conda is available but returned no environments.'),
    }
  } catch {
    return {
      ok: false,
      condaExecutable,
      environments: [],
      message: t('Conda returned an environment list that could not be parsed.'),
    }
  }
}

export function parseCondaEnvironments(output: string, platform: NodeJS.Platform): CondaEnvironment[] {
  const parsed = JSON.parse(output) as {
    active_prefix?: unknown
    envs?: unknown
    root_prefix?: unknown
  }
  if (!Array.isArray(parsed.envs)) throw new Error('Invalid Conda environment list')

  const pathApi = platform === 'win32' ? win32 : posix
  const comparable = (value: string): string => (platform === 'win32' ? value.toLowerCase() : value)
  const rootPrefix =
    typeof parsed.root_prefix === 'string' ? comparable(pathApi.normalize(parsed.root_prefix)) : undefined
  const activePrefix =
    typeof parsed.active_prefix === 'string' ? comparable(pathApi.normalize(parsed.active_prefix)) : undefined
  const seen = new Set<string>()
  const environments: CondaEnvironment[] = []

  for (const entry of parsed.envs) {
    if (typeof entry !== 'string' || !entry.trim()) continue
    const path = pathApi.normalize(entry)
    const key = comparable(path)
    if (seen.has(key)) continue
    seen.add(key)
    environments.push({
      name: rootPrefix === key ? 'base' : pathApi.basename(path),
      path,
      active: activePrefix === key,
    })
  }
  return environments
}

async function resolveRuntimeUncached(
  kind: DeveloperRuntimeKind,
  settings: DeveloperRuntimeSettings,
  workingDirectory?: string,
): Promise<ResolvedRuntime | undefined> {
  if (kind === 'jdk') {
    const config = settings.jdk
    const javaExecutable = process.platform === 'win32' ? 'java.exe' : 'java'
    if (config.mode === 'custom') {
      return probeCandidates('jdk', [join(config.home, 'bin', javaExecutable)], ['-version'], config.home)
    }
    const fromJavaHome = process.env.JAVA_HOME
      ? await probeCandidates(
          'jdk',
          [join(process.env.JAVA_HOME, 'bin', javaExecutable)],
          ['-version'],
          process.env.JAVA_HOME,
        )
      : undefined
    return fromJavaHome ?? probeCandidates('jdk', [javaExecutable], ['-version'])
  }
  if (kind === 'go') {
    const config = settings.go
    const goExecutable = process.platform === 'win32' ? 'go.exe' : 'go'
    if (config.mode === 'custom') {
      return probeCandidates(
        'go',
        [config.executable || join(config.root, 'bin', goExecutable)],
        ['version'],
        config.root,
      )
    }
    const fromGoRoot = process.env.GOROOT
      ? await probeCandidates('go', [join(process.env.GOROOT, 'bin', goExecutable)], ['version'], process.env.GOROOT)
      : undefined
    return fromGoRoot ?? probeCandidates('go', [goExecutable], ['version'])
  }
  if (kind === 'php') {
    const config = settings.php
    return probeCandidates(
      'php',
      [config.mode === 'custom' ? config.executable : process.platform === 'win32' ? 'php.exe' : 'php'],
      ['-v'],
    )
  }
  return resolvePythonRuntime(settings, workingDirectory)
}

async function resolvePythonRuntime(
  settings: DeveloperRuntimeSettings,
  workingDirectory?: string,
): Promise<ResolvedRuntime | undefined> {
  const config = settings.python
  if (config.mode === 'venv') {
    return probePythonEnvironment(config.environment, 'venv')
  }
  if (config.mode === 'conda') {
    const prefix = isAbsolute(config.environment)
      ? config.environment
      : await findCondaEnvironment(config.condaExecutable || 'conda', config.environment)
    return prefix ? probePythonEnvironment(prefix, 'conda') : undefined
  }
  if (config.mode === 'custom') {
    return probeCandidates('python', [config.executable], ['--version'])
  }

  const environments: Array<{ path: string; layout: 'venv' | 'conda' }> =
    config.mode === 'auto'
      ? [
          { path: workingDirectory ? join(workingDirectory, '.venv') : '', layout: 'venv' },
          { path: workingDirectory ? join(workingDirectory, 'venv') : '', layout: 'venv' },
          { path: process.env.VIRTUAL_ENV || '', layout: 'venv' },
          { path: process.env.CONDA_PREFIX || '', layout: 'conda' },
        ]
      : []
  for (const environment of environments.filter(({ path }) => Boolean(path))) {
    const runtime = await probePythonEnvironment(environment.path, environment.layout)
    if (runtime) return runtime
  }
  const candidates = config.executable
    ? [config.executable]
    : process.platform === 'win32'
      ? ['python.exe', 'python3.exe', 'py.exe']
      : ['python3', 'python']
  for (const executable of candidates) {
    const prefixArgs =
      basename(executable)
        .toLowerCase()
        .replace(/\.exe$/, '') === 'py'
        ? ['-3']
        : []
    const runtime = await probeRuntime('python', executable, [...prefixArgs, '--version'], prefixArgs)
    if (runtime) return runtime
  }
  return undefined
}

async function probePythonEnvironment(
  environmentPath: string,
  layout: 'venv' | 'conda',
): Promise<ResolvedRuntime | undefined> {
  const normalized = normalize(environmentPath)
  const executable =
    layout === 'conda'
      ? pythonExecutableInCondaEnvironment(normalized, process.platform)
      : pythonExecutableInEnvironment(normalized, process.platform)
  const runtime = await probeRuntime('python', executable, ['--version'])
  return runtime ? { ...runtime, environmentPath: normalized, environmentType: layout } : undefined
}

async function findCondaEnvironment(condaExecutable: string, environment: string): Promise<string | undefined> {
  const result = await listCondaEnvironments(condaExecutable)
  if (!result.ok) return undefined
  const target = process.platform === 'win32' ? environment.toLowerCase() : environment
  return result.environments.find((entry) => {
    const name = process.platform === 'win32' ? entry.name.toLowerCase() : entry.name
    const path = process.platform === 'win32' ? entry.path.toLowerCase() : entry.path
    return name === target || path === target
  })?.path
}

async function probeCandidates(
  kind: DeveloperRuntimeKind,
  candidates: string[],
  versionArgs: string[],
  home?: string,
): Promise<ResolvedRuntime | undefined> {
  for (const executable of candidates.filter(Boolean)) {
    if (isAbsolute(executable) && !existsSync(executable)) continue
    const runtime = await probeRuntime(kind, executable, versionArgs)
    if (runtime) return { ...runtime, home: home || undefined }
  }
  return undefined
}

async function probeRuntime(
  kind: DeveloperRuntimeKind,
  executable: string,
  versionArgs: string[],
  prefixArgs: string[] = [],
): Promise<ResolvedRuntime | undefined> {
  if (!executable) return undefined
  const result = await captureProcess(executable, versionArgs, 3_000)
  if (!result.ok) return undefined
  const version = result.output.split(/\r?\n/).find(Boolean)?.trim() || runtimeDisplayName(kind)
  return { kind, executable, prefixArgs, version }
}

function captureProcess(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; output: string; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const normalizedStdout = stdout.trim()
      const normalizedStderr = stderr.trim()
      resolve({
        ok,
        stdout: normalizedStdout,
        stderr: normalizedStderr,
        output: [normalizedStdout, normalizedStderr].filter(Boolean).join('\n'),
      })
    }
    const appendStdout = (chunk: Buffer) => {
      if (stdout.length < 100_000) stdout += chunk.toString('utf8').slice(0, 100_000 - stdout.length)
    }
    const appendStderr = (chunk: Buffer) => {
      if (stderr.length < 20_000) stderr += chunk.toString('utf8').slice(0, 20_000 - stderr.length)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(false)
    }, timeoutMs)
    child.stdout?.on('data', appendStdout)
    child.stderr?.on('data', appendStderr)
    child.once('error', () => finish(false))
    child.once('close', (code) => finish(code === 0))
  })
}

function runtimeDisplayName(kind: DeveloperRuntimeKind): string {
  return kind === 'jdk' ? 'JDK' : kind === 'go' ? 'Go' : kind === 'php' ? 'PHP' : 'Python'
}
