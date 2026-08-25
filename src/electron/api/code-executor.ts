import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { DeveloperRuntimeSettings } from '../../shared/types'
import { resolveDeveloperRuntime } from './runtime-environments'
import { getLanguage, t } from '../../shared/i18n'

export type ExecutableLanguage = 'javascript' | 'python'

export interface CodeExecutionRequest {
  language: ExecutableLanguage
  code: string
  input?: unknown
  timeoutMs?: number
  workingDirectory?: string
  runtimeSettings?: DeveloperRuntimeSettings
}

export interface CodeExecutionResult {
  result: string
  isError: boolean
  truncated?: boolean
}

const MAX_CODE_CHARACTERS = 100_000
const MAX_OUTPUT_CHARACTERS = 200_000
const MIN_TIMEOUT_MS = 500
const MAX_TIMEOUT_MS = 20_000

const JAVASCRIPT_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const vm = require('node:vm')
const util = require('node:util')

const output = []
let outputLength = 0
let truncated = false
const append = (values) => {
  if (truncated) return
  const line = values.map((value) => typeof value === 'string' ? value : util.inspect(value, { depth: 5, maxArrayLength: 100 })).join(' ')
  const remaining = workerData.maxOutput - outputLength
  if (remaining <= 0) {
    truncated = true
    return
  }
  output.push(line.slice(0, remaining))
  outputLength += Math.min(line.length, remaining) + 1
  if (line.length > remaining) truncated = true
}

const sandbox = Object.create(null)
sandbox.console = Object.freeze({
  log: (...values) => append(values),
  info: (...values) => append(values),
  warn: (...values) => append(values),
  error: (...values) => append(values),
})
sandbox.input = workerData.input

const context = vm.createContext(sandbox, {
  name: 'AgentBox Code Runner',
  codeGeneration: { strings: false, wasm: false },
})

;(async () => {
  try {
    const source = '(async () => {\n' + workerData.code + '\n})()'
    const script = new vm.Script(source, { filename: 'agentbox-user-code.js' })
    const value = await script.runInContext(context, { timeout: workerData.timeoutMs })
    if (value !== undefined) append(['Result:', value])
    const result = output.join('\n') || workerData.messages.noOutput
    parentPort.postMessage({ result: result + (truncated ? '\n' + workerData.messages.outputTruncated : ''), isError: false, truncated })
  } catch (error) {
    const message = error && error.stack ? error.stack : String(error)
    append([message])
    parentPort.postMessage({ result: output.join('\n') + (truncated ? '\n' + workerData.messages.outputTruncated : ''), isError: true, truncated })
  }
})()
`

const PYTHON_WRAPPER = String.raw`
import ast
import builtins
import json

USER_CODE = __USER_CODE__
USER_INPUT = json.loads(__USER_INPUT__)
ALLOWED_MODULES = {
    "bisect", "collections", "dataclasses", "datetime", "decimal", "enum",
    "fractions", "functools", "heapq", "itertools", "json", "math", "random",
    "re", "statistics", "string", "time", "typing"
}
SAFE_BUILTIN_NAMES = {
    "__build_class__", "abs", "all", "any", "bool", "bytearray", "bytes", "callable",
    "chr", "classmethod", "complex", "dict", "divmod", "enumerate", "filter", "float",
    "format", "frozenset", "hash", "hex", "int", "isinstance", "issubclass", "iter",
    "len", "list", "map", "max", "memoryview", "min", "next", "object", "oct", "ord",
    "pow", "print", "property", "range", "repr", "reversed", "round", "set", "slice",
    "sorted", "staticmethod", "str", "sum", "super", "tuple", "type", "zip",
    "ArithmeticError", "AssertionError", "Exception", "IndexError", "KeyError", "RuntimeError",
    "StopIteration", "TypeError", "ValueError", "ZeroDivisionError"
}

real_import = builtins.__import__
def safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.split(".", 1)[0]
    if level != 0 or root not in ALLOWED_MODULES:
        raise ImportError(__MODULE_NOT_ALLOWED__.format(name=repr(name)))
    return real_import(name, globals, locals, fromlist, level)

safe_builtins = {name: getattr(builtins, name) for name in SAFE_BUILTIN_NAMES}
safe_builtins["__import__"] = safe_import
tree = ast.parse(USER_CODE, filename="agentbox-user-code.py", mode="exec")
for node in ast.walk(tree):
    if isinstance(node, ast.Attribute) and node.attr.startswith("__"):
        raise PermissionError(__DUNDER_NOT_ALLOWED__)
    if isinstance(node, ast.Name) and node.id in {"eval", "exec", "compile", "open", "globals", "locals", "vars", "getattr", "setattr", "delattr"}:
        raise PermissionError(__NAME_NOT_ALLOWED__.format(name=node.id))

scope = {"__builtins__": safe_builtins, "__name__": "__main__", "input_data": USER_INPUT}
exec(compile(tree, "agentbox-user-code.py", "exec"), scope, scope)
`

let pythonCommandPromise: Promise<{ command: string; prefixArgs: string[] } | undefined> | undefined

export async function executeCode(request: CodeExecutionRequest, signal?: AbortSignal): Promise<CodeExecutionResult> {
  if (!request.code.trim()) return { result: t('Code cannot be empty.'), isError: true }
  if (request.code.length > MAX_CODE_CHARACTERS) {
    return {
      result: t('Code length exceeds {value0} character limit.', {
        value0: MAX_CODE_CHARACTERS.toLocaleString(getLanguage()),
      }),
      isError: true,
    }
  }
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, request.timeoutMs ?? 8_000))
  if (request.language === 'javascript') {
    return executeJavaScript(request.code, request.input, timeoutMs, signal)
  }
  return executePython(
    request.code,
    request.input,
    timeoutMs,
    signal,
    request.runtimeSettings,
    request.workingDirectory,
  )
}

function executeJavaScript(
  code: string,
  input: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CodeExecutionResult> {
  return new Promise((resolve) => {
    const worker = new Worker(JAVASCRIPT_WORKER_SOURCE, {
      eval: true,
      workerData: {
        code,
        input,
        timeoutMs,
        maxOutput: MAX_OUTPUT_CHARACTERS,
        messages: {
          noOutput: t('(Code execution completed with no output)'),
          outputTruncated: t('[Output truncated]'),
        },
      },
      resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 4 },
    })
    let settled = false
    const finish = (result: CodeExecutionResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      void worker.terminate()
      resolve(result)
    }
    const onAbort = () => finish({ result: t('Code execution canceled.'), isError: true })
    const timer = setTimeout(
      () =>
        finish({
          result: t('Code execution exceeded {value0} seconds and terminated.', {
            value0: (timeoutMs / 1_000).toFixed(1),
          }),
          isError: true,
        }),
      timeoutMs + 250,
    )
    worker.once('message', (message: CodeExecutionResult) => finish(message))
    worker.once('error', (error) => finish({ result: error.stack || error.message, isError: true }))
    worker.once('exit', (code) => {
      if (!settled)
        finish({
          result: t('The code runner exited abnormally (exit code {value0}).', { value0: code }),
          isError: true,
        })
    })
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function executePython(
  code: string,
  input: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
  runtimeSettings?: DeveloperRuntimeSettings,
  workingDirectory?: string,
): Promise<CodeExecutionResult> {
  const configuredRuntime = runtimeSettings
    ? await resolveDeveloperRuntime('python', runtimeSettings, workingDirectory)
    : undefined
  const requiresConfiguredRuntime = Boolean(
    runtimeSettings &&
    (['venv', 'conda', 'custom'].includes(runtimeSettings.python.mode) ||
      (runtimeSettings.python.mode === 'system' && runtimeSettings.python.executable)),
  )
  const python = configuredRuntime
    ? { command: configuredRuntime.executable, prefixArgs: configuredRuntime.prefixArgs }
    : requiresConfiguredRuntime
      ? undefined
      : await resolvePythonCommand()
  if (!python) {
    return {
      result: t(
        'No available Python 3 interpreter detected. Please use language="javascript" instead, or install Python 3 in your system PATH.',
      ),
      isError: true,
    }
  }

  const tempDirectory = await mkdtemp(join(tmpdir(), 'agentbox-code-'))
  const scriptPath = join(tempDirectory, 'runner.py')
  try {
    const wrapper = PYTHON_WRAPPER.replace('__USER_INPUT__', JSON.stringify(JSON.stringify(input ?? null)))
      .replace('__USER_CODE__', JSON.stringify(code))
      .replace('__MODULE_NOT_ALLOWED__', JSON.stringify(t('Module {name} is not allowed')))
      .replace('__DUNDER_NOT_ALLOWED__', JSON.stringify(t('Double-underscore attributes are not allowed')))
      .replace('__NAME_NOT_ALLOWED__', JSON.stringify(t('{name} is not allowed')))
    await writeFile(scriptPath, wrapper, { encoding: 'utf8', mode: 0o600 })
    return await runProcess(
      python.command,
      [...python.prefixArgs, '-I', '-u', scriptPath],
      timeoutMs,
      signal,
      workingDirectory || tempDirectory,
    )
  } finally {
    await rm(tempDirectory, { recursive: true, force: true })
  }
}

async function resolvePythonCommand(): Promise<{ command: string; prefixArgs: string[] } | undefined> {
  pythonCommandPromise ??= (async () => {
    const candidates =
      process.platform === 'win32'
        ? [
            { command: 'py', prefixArgs: ['-3'] },
            { command: 'python', prefixArgs: [] },
            { command: 'python3', prefixArgs: [] },
          ]
        : [
            { command: 'python3', prefixArgs: [] },
            { command: 'python', prefixArgs: [] },
          ]
    for (const candidate of candidates) {
      const result = await runProcess(candidate.command, [...candidate.prefixArgs, '--version'], 2_000)
      if (!result.isError && /python 3/i.test(result.result)) return candidate
    }
    return undefined
  })()
  return pythonCommandPromise
}

function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
  cwd?: string,
): Promise<CodeExecutionResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
        PYTHONIOENCODING: 'utf-8',
        PYTHONDONTWRITEBYTECODE: '1',
      },
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
    const finish = (result: CodeExecutionResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const onAbort = () => {
      child.kill()
      finish({ result: t('Code execution canceled.'), isError: true })
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({
        result: t('Code execution exceeded {value0} seconds and terminated.\n{value1}{value2}', {
          value0: (timeoutMs / 1_000).toFixed(1),
          value1: output,
          value2: truncated ? `\n${t('[Output truncated]')}` : '',
        }).trim(),
        isError: true,
        truncated,
      })
    }, timeoutMs)
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.once('error', (error) => finish({ result: error.message, isError: true }))
    child.once('close', (code) =>
      finish({
        result: output.trim()
          ? `${output.trim()}${truncated ? `\n${t('[Output truncated]')}` : ''}`
          : t('(Process exited with code {value0}; no output)', { value0: code ?? 'unknown' }),
        isError: code !== 0,
        truncated,
      }),
    )
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}
