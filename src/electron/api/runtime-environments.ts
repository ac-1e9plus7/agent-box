import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, posix, win32 } from 'node:path'
import type {
  DeveloperRuntimeKind,
  DeveloperRuntimeSettings,
  RuntimeTestResult,
} from '../../shared/types'

export interface ResolvedRuntime {
  kind: DeveloperRuntimeKind
  executable: string
  prefixArgs: string[]
  version: string
  home?: string
  environmentPath?: string
}

const runtimeCache = new Map<string, Promise<ResolvedRuntime | undefined>>()

export async function resolveDeveloperRuntime(
  kind: DeveloperRuntimeKind,
  settings: DeveloperRuntimeSettings,
  workingDirectory?: string,
): Promise<ResolvedRuntime | undefined> {
  const cacheKey = JSON.stringify([kind, settings[kind], kind === 'python' ? workingDirectory || '' : '', process.platform])
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
        message: `未找到可用的 ${runtimeDisplayName(kind)} 运行时，请检查自动探测结果或指定路径。`,
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
  if (jdk?.home) env.JAVA_HOME = jdk.home
  if (go?.home) env.GOROOT = go.home
  if (python?.environmentPath) {
    if (settings.python.mode === 'conda' || basename(python.environmentPath).toLowerCase().includes('conda')) {
      env.CONDA_PREFIX = python.environmentPath
    } else {
      env.VIRTUAL_ENV = python.environmentPath
    }
  }
  env[pathKey] = [...new Set(pathEntries), env[pathKey] || ''].filter(Boolean).join(process.platform === 'win32' ? ';' : ':')
  return env
}

export function pythonExecutableInEnvironment(environmentPath: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? win32.join(environmentPath, 'Scripts', 'python.exe')
    : posix.join(environmentPath, 'bin', 'python')
}

async function resolveRuntimeUncached(
  kind: DeveloperRuntimeKind,
  settings: DeveloperRuntimeSettings,
  workingDirectory?: string,
): Promise<ResolvedRuntime | undefined> {
  if (kind === 'jdk') {
    const config = settings.jdk
    const candidates = config.mode === 'custom'
      ? [join(config.home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')]
      : [
          process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : '',
          process.platform === 'win32' ? 'java.exe' : 'java',
        ]
    return probeCandidates('jdk', candidates, ['-version'], config.mode === 'custom' ? config.home : process.env.JAVA_HOME)
  }
  if (kind === 'go') {
    const config = settings.go
    const candidates = config.mode === 'custom'
      ? [config.executable || join(config.root, 'bin', process.platform === 'win32' ? 'go.exe' : 'go')]
      : [
          process.env.GOROOT ? join(process.env.GOROOT, 'bin', process.platform === 'win32' ? 'go.exe' : 'go') : '',
          process.platform === 'win32' ? 'go.exe' : 'go',
        ]
    return probeCandidates('go', candidates, ['version'], config.root || process.env.GOROOT)
  }
  if (kind === 'php') {
    const config = settings.php
    return probeCandidates('php', [config.mode === 'custom' ? config.executable : (process.platform === 'win32' ? 'php.exe' : 'php')], ['-v'])
  }
  return resolvePythonRuntime(settings, workingDirectory)
}

async function resolvePythonRuntime(
  settings: DeveloperRuntimeSettings,
  workingDirectory?: string,
): Promise<ResolvedRuntime | undefined> {
  const config = settings.python
  if (config.mode === 'venv') {
    return probePythonEnvironment(config.environment)
  }
  if (config.mode === 'conda') {
    const prefix = isAbsolute(config.environment)
      ? config.environment
      : await findCondaEnvironment(config.condaExecutable || 'conda', config.environment)
    return prefix ? probePythonEnvironment(prefix) : undefined
  }
  if (config.mode === 'custom') {
    return probeCandidates('python', [config.executable], ['--version'])
  }

  const environments = config.mode === 'auto'
    ? [
        workingDirectory ? join(workingDirectory, '.venv') : '',
        workingDirectory ? join(workingDirectory, 'venv') : '',
        process.env.VIRTUAL_ENV || '',
        process.env.CONDA_PREFIX || '',
      ]
    : []
  for (const environment of environments.filter(Boolean)) {
    const runtime = await probePythonEnvironment(environment)
    if (runtime) return runtime
  }
  const candidates = config.executable
    ? [config.executable]
    : process.platform === 'win32'
      ? ['python.exe', 'python3.exe', 'py.exe']
      : ['python3', 'python']
  for (const executable of candidates) {
    const prefixArgs = basename(executable).toLowerCase().replace(/\.exe$/, '') === 'py' ? ['-3'] : []
    const runtime = await probeRuntime('python', executable, [...prefixArgs, '--version'], prefixArgs)
    if (runtime) return runtime
  }
  return undefined
}

async function probePythonEnvironment(environmentPath: string): Promise<ResolvedRuntime | undefined> {
  const normalized = normalize(environmentPath)
  const executable = pythonExecutableInEnvironment(normalized, process.platform)
  const runtime = await probeRuntime('python', executable, ['--version'])
  return runtime ? { ...runtime, environmentPath: normalized } : undefined
}

async function findCondaEnvironment(condaExecutable: string, environment: string): Promise<string | undefined> {
  const result = await captureProcess(condaExecutable, ['env', 'list', '--json'], 5_000)
  if (!result.ok) return undefined
  try {
    const parsed = JSON.parse(result.output) as { envs?: unknown }
    if (!Array.isArray(parsed.envs)) return undefined
    const target = process.platform === 'win32' ? environment.toLowerCase() : environment
    return parsed.envs.find((entry): entry is string => {
      if (typeof entry !== 'string') return false
      const name = basename(entry)
      return (process.platform === 'win32' ? name.toLowerCase() : name) === target
    })
  } catch {
    return undefined
  }
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

function captureProcess(command: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok, output: output.trim() })
    }
    const append = (chunk: Buffer) => { output += chunk.toString('utf8').slice(0, 20_000 - output.length) }
    const timer = setTimeout(() => { child.kill(); finish(false) }, timeoutMs)
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.once('error', () => finish(false))
    child.once('close', (code) => finish(code === 0))
  })
}

function runtimeDisplayName(kind: DeveloperRuntimeKind): string {
  return kind === 'jdk' ? 'JDK' : kind === 'go' ? 'Go' : kind === 'php' ? 'PHP' : 'Python'
}
