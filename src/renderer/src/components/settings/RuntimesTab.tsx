import { useEffect, useState } from 'react'
import type { Dispatch, JSX, SetStateAction } from 'react'
import type {
  CondaEnvironmentListResult,
  DeveloperRuntimeKind,
  DeveloperRuntimeSettings,
  RuntimeTestResult,
} from '../../../../shared/types'
import type { AppPreferences } from '../../types'
import { t } from '../../../../shared/i18n'
import { Icon } from '../Icon'
import { FieldLabel } from './SettingsControls'

interface RuntimesTabProps {
  chooseDirectory: (current?: string) => Promise<string | undefined>
  onListCondaEnvironments?: (condaExecutable: string) => Promise<CondaEnvironmentListResult>
  onTestRuntime?: (
    kind: DeveloperRuntimeKind,
    settings: DeveloperRuntimeSettings,
    workingDirectory?: string,
  ) => Promise<RuntimeTestResult>
  preferenceDraft: AppPreferences
  setPreferenceDraft: Dispatch<SetStateAction<AppPreferences>>
}

export function RuntimesTab({
  chooseDirectory,
  onListCondaEnvironments,
  onTestRuntime,
  preferenceDraft,
  setPreferenceDraft,
}: RuntimesTabProps): JSX.Element {
  const [runtimeTestResults, setRuntimeTestResults] = useState<Partial<Record<DeveloperRuntimeKind, RuntimeTestResult>>>({})
  const [testingRuntime, setTestingRuntime] = useState<DeveloperRuntimeKind | null>(null)
  const [condaEnvironmentResult, setCondaEnvironmentResult] = useState<CondaEnvironmentListResult | null>(null)
  const [loadingCondaEnvironments, setLoadingCondaEnvironments] = useState(false)
  const [condaEnvironmentRefresh, setCondaEnvironmentRefresh] = useState(0)

  useEffect(() => {
    if (
      preferenceDraft.developerRuntimes.python.mode !== 'conda'
      || !onListCondaEnvironments
    ) {
      setCondaEnvironmentResult(null)
      setLoadingCondaEnvironments(false)
      return
    }

    let cancelled = false
    const timer = window.setTimeout(() => {
      setLoadingCondaEnvironments(true)
      void onListCondaEnvironments(
        preferenceDraft.developerRuntimes.python.condaExecutable.trim() || 'conda',
      ).then((result) => {
        if (cancelled) return
        setCondaEnvironmentResult(result)
        if (!result.ok || result.environments.length === 0) return

        setPreferenceDraft((current) => {
          const configured = current.developerRuntimes.python.environment
          const matched = result.environments.find((environment) => (
            environment.path === configured || environment.name === configured
          )) ?? result.environments.find((environment) => (
            environment.path.toLowerCase() === configured.toLowerCase()
            || environment.name.toLowerCase() === configured.toLowerCase()
          ))
          if (configured && !matched) return current
          const environment = matched
            ?? result.environments.find((candidate) => candidate.active)
            ?? result.environments[0]
          if (!environment || configured === environment.path) return current
          return {
            ...current,
            developerRuntimes: {
              ...current.developerRuntimes,
              python: { ...current.developerRuntimes.python, environment: environment.path },
            },
          }
        })
      }).catch((error: unknown) => {
        if (cancelled) return
        setCondaEnvironmentResult({
          ok: false,
          condaExecutable: preferenceDraft.developerRuntimes.python.condaExecutable,
          environments: [],
          message: error instanceof Error ? error.message : t("读取 Conda 环境失败。"),
        })
      }).finally(() => {
        if (!cancelled) setLoadingCondaEnvironments(false)
      })
    }, 350)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [
    condaEnvironmentRefresh,
    onListCondaEnvironments,
    preferenceDraft.developerRuntimes.python.condaExecutable,
    preferenceDraft.developerRuntimes.python.mode,
    setPreferenceDraft,
  ])

  const testRuntime = async (kind: DeveloperRuntimeKind): Promise<void> => {
    if (!onTestRuntime) return
    setTestingRuntime(kind)
    try {
      const result = await onTestRuntime(
        kind,
        preferenceDraft.developerRuntimes,
        preferenceDraft.defaultWorkingDirectory || undefined,
      )
      setRuntimeTestResults((current) => ({ ...current, [kind]: result }))
    } finally {
      setTestingRuntime(null)
    }
  }

  return (
              <div className="settings-section-content runtime-settings-panel">
                <section className="settings-card">
                  <h3>{t("运行时解析规则")}</h3>
                  <p className="runtime-intro">{t("自动模式优先使用当前会话工作目录中的环境，再回退到系统环境变量与 PATH。配置会注入 Integrated terminal，并用于代码执行工具。")}</p>
                </section>

                {(['jdk', 'go', 'php'] as const).map((kind) => {
                  const runtime = preferenceDraft.developerRuntimes[kind]
                  const label = kind === 'jdk' ? 'JDK' : kind === 'go' ? 'Go' : 'PHP'
                  const result = runtimeTestResults[kind]
                  return (
                    <section className="settings-card runtime-card" key={kind}>
                      <div className="runtime-card-header">
                        <div><h3>{label}</h3><small>{kind === 'jdk' ? t("提供 JAVA_HOME 和 java") : kind === 'go' ? t("提供 go 与可选 GOROOT") : t("提供 php CLI")}</small></div>
                        <div className="segmented-control">
                          {(['auto', 'custom'] as const).map((mode) => (
                            <button
                              className={runtime.mode === mode ? 'is-active' : ''}
                              key={mode}
                              onClick={() => setPreferenceDraft((current) => ({
                                ...current,
                                developerRuntimes: {
                                  ...current.developerRuntimes,
                                  [kind]: { ...current.developerRuntimes[kind], mode }
                                }
                              }))}
                            >
                              {mode === 'auto' ? t("自动") : t("指定")}
                            </button>
                          ))}
                        </div>
                      </div>
                      {runtime.mode === 'custom' && (
                        <div className="runtime-fields">
                          {kind === 'jdk' && (
                            <label><FieldLabel hint={t("JDK 根目录，需包含 bin/java")}>JAVA_HOME</FieldLabel><div className="runtime-path-input"><input className="mono-input" value={preferenceDraft.developerRuntimes.jdk.home} onChange={(event) => setPreferenceDraft((current) => ({ ...current, developerRuntimes: { ...current.developerRuntimes, jdk: { ...current.developerRuntimes.jdk, home: event.target.value } } }))} /><button className="secondary-button" onClick={async () => { const path = await chooseDirectory(preferenceDraft.developerRuntimes.jdk.home); if (path) setPreferenceDraft((current) => ({ ...current, developerRuntimes: { ...current.developerRuntimes, jdk: { ...current.developerRuntimes.jdk, home: path } } })) }}><Icon name="folder" size={13} /></button></div></label>
                          )}
                          {kind === 'go' && (
                            <>
                              <label><FieldLabel hint={t("go 或 go.exe 的路径；留空时使用 GOROOT/bin/go")}>{t("Go 可执行文件")}</FieldLabel><input className="mono-input" value={preferenceDraft.developerRuntimes.go.executable} onChange={(event) => setPreferenceDraft((current) => ({ ...current, developerRuntimes: { ...current.developerRuntimes, go: { ...current.developerRuntimes.go, executable: event.target.value } } }))} /></label>
                              <label><FieldLabel hint={t("可选 Go 安装根目录")}>GOROOT</FieldLabel><div className="runtime-path-input"><input className="mono-input" value={preferenceDraft.developerRuntimes.go.root} onChange={(event) => setPreferenceDraft((current) => ({ ...current, developerRuntimes: { ...current.developerRuntimes, go: { ...current.developerRuntimes.go, root: event.target.value } } }))} /><button className="secondary-button" onClick={async () => { const path = await chooseDirectory(preferenceDraft.developerRuntimes.go.root); if (path) setPreferenceDraft((current) => ({ ...current, developerRuntimes: { ...current.developerRuntimes, go: { ...current.developerRuntimes.go, root: path } } })) }}><Icon name="folder" size={13} /></button></div></label>
                            </>
                          )}
                          {kind === 'php' && (
                            <label><FieldLabel hint={t("php 或 php.exe 的可执行文件路径")}>{t("PHP 可执行文件")}</FieldLabel><input className="mono-input" value={preferenceDraft.developerRuntimes.php.executable} onChange={(event) => setPreferenceDraft((current) => ({ ...current, developerRuntimes: { ...current.developerRuntimes, php: { ...current.developerRuntimes.php, executable: event.target.value } } }))} /></label>
                          )}
                        </div>
                      )}
                      <div className="runtime-test-row"><button className="secondary-button" disabled={testingRuntime === kind} onClick={() => void testRuntime(kind)}>{testingRuntime === kind ? t("检测中…") : t("检测 {value0}", { value0: label })}</button>{result && <span className={result.ok ? 'is-ok' : 'is-error'}>{result.message}</span>}</div>
                    </section>
                  )
                })}

                <section className="settings-card runtime-card">
                  <div className="runtime-card-header"><div><h3>Python</h3><small>{t("支持项目 .venv、普通 venv、Conda 与自定义解释器")}</small></div></div>
                  <div className="python-runtime-modes">
                    {(['auto', 'system', 'venv', 'conda', 'custom'] as const).map((mode) => (
                      <button className={preferenceDraft.developerRuntimes.python.mode === mode ? 'is-active' : ''} key={mode} onClick={() => setPreferenceDraft((current) => ({ ...current, developerRuntimes: { ...current.developerRuntimes, python: { ...current.developerRuntimes.python, mode } } }))}>
                        {mode === 'auto' ? t("自动") : mode === 'system' ? t("系统") : mode === 'venv' ? 'venv' : mode === 'conda' ? 'Conda' : t("指定解释器")}
                      </button>
                    ))}
                  </div>
                  <div className="runtime-fields">
                    {preferenceDraft.developerRuntimes.python.mode === 'auto' && <p className="runtime-mode-hint">{t("依次检测工作目录的 .venv/venv、VIRTUAL_ENV、CONDA_PREFIX，再回退到系统 Python 3。")}</p>}
                    {preferenceDraft.developerRuntimes.python.mode === 'system' && <label><FieldLabel hint={t("可选；留空时自动尝试 python3/python/py -3")}>{t("系统 Python 可执行文件")}</FieldLabel><input className="mono-input" value={preferenceDraft.developerRuntimes.python.executable} onChange={(event) => setPreferenceDraft((current) => ({ ...current, developerRuntimes: { ...current.developerRuntimes, python: { ...current.developerRuntimes.python, executable: event.target.value } } }))} /></label>}
                    {preferenceDraft.developerRuntimes.python.mode === 'venv' && <label><FieldLabel hint={t("venv 根目录，Windows 使用 Scripts/python.exe，macOS/Linux 使用 bin/python")}>{t("venv 路径")}</FieldLabel><div className="runtime-path-input"><input className="mono-input" value={preferenceDraft.developerRuntimes.python.environment} onChange={(event) => setPreferenceDraft((current) => ({ ...current, developerRuntimes: { ...current.developerRuntimes, python: { ...current.developerRuntimes.python, environment: event.target.value } } }))} /><button className="secondary-button" onClick={async () => { const path = await chooseDirectory(preferenceDraft.developerRuntimes.python.environment); if (path) setPreferenceDraft((current) => ({ ...current, developerRuntimes: { ...current.developerRuntimes, python: { ...current.developerRuntimes.python, environment: path } } })) }}><Icon name="folder" size={13} /></button></div></label>}
                    {preferenceDraft.developerRuntimes.python.mode === 'conda' && (
                      <>
                        <label>
                          <FieldLabel hint={t("默认 conda；也可粘贴 conda.exe/conda 的完整路径")}>{t("Conda 可执行文件")}</FieldLabel>
                          <div className="runtime-path-input">
                            <input
                              className="mono-input"
                              placeholder={t("conda 或 C:\\\\...\\\\conda.exe")}
                              value={preferenceDraft.developerRuntimes.python.condaExecutable}
                              onChange={(event) => setPreferenceDraft((current) => ({
                                ...current,
                                developerRuntimes: {
                                  ...current.developerRuntimes,
                                  python: {
                                    ...current.developerRuntimes.python,
                                    condaExecutable: event.target.value,
                                  },
                                },
                              }))}
                            />
                            <button
                              aria-label={t("刷新 Conda 环境")}
                              className="secondary-button"
                              disabled={loadingCondaEnvironments}
                              onClick={() => setCondaEnvironmentRefresh((current) => current + 1)}
                              title={t("重新读取 Conda 环境")}
                              type="button"
                            >
                              <Icon name="refresh" size={13} />
                            </button>
                          </div>
                          <small className={`runtime-field-status ${condaEnvironmentResult?.ok ? 'is-ok' : condaEnvironmentResult ? 'is-error' : ''}`}>
                            {loadingCondaEnvironments
                              ? t("正在读取 Conda 环境…")
                              : condaEnvironmentResult?.message ?? t("输入后将自动检测 Conda。")}
                          </small>
                        </label>
                        <label>
                          <FieldLabel hint={t("检测到有效 Conda 后可直接选择；保存实际的环境 prefix 路径")}>{t("Conda 环境")}</FieldLabel>
                          {condaEnvironmentResult?.ok && condaEnvironmentResult.environments.length > 0 ? (
                            <select
                              className="mono-input runtime-environment-select"
                              value={preferenceDraft.developerRuntimes.python.environment}
                              onChange={(event) => setPreferenceDraft((current) => ({
                                ...current,
                                developerRuntimes: {
                                  ...current.developerRuntimes,
                                  python: {
                                    ...current.developerRuntimes.python,
                                    environment: event.target.value,
                                  },
                                },
                              }))}
                            >
                              {preferenceDraft.developerRuntimes.python.environment
                                && !condaEnvironmentResult.environments.some((environment) => (
                                  environment.path === preferenceDraft.developerRuntimes.python.environment
                                )) && (
                                  <option value={preferenceDraft.developerRuntimes.python.environment}>{t("当前配置（未在环境列表中）— {value0}", { value0: preferenceDraft.developerRuntimes.python.environment })}
                                  </option>
                                )}
                              {condaEnvironmentResult.environments.map((environment) => (
                                <option key={environment.path} value={environment.path}>
                                  {environment.name}{environment.active ? t("（当前）") : ''} — {environment.path}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              className="mono-input"
                              placeholder={t("环境名称或绝对 prefix 路径")}
                              value={preferenceDraft.developerRuntimes.python.environment}
                              onChange={(event) => setPreferenceDraft((current) => ({
                                ...current,
                                developerRuntimes: {
                                  ...current.developerRuntimes,
                                  python: {
                                    ...current.developerRuntimes.python,
                                    environment: event.target.value,
                                  },
                                },
                              }))}
                            />
                          )}
                        </label>
                      </>
                    )}
                    {preferenceDraft.developerRuntimes.python.mode === 'custom' && <label><FieldLabel>{t("Python 可执行文件")}</FieldLabel><input className="mono-input" value={preferenceDraft.developerRuntimes.python.executable} onChange={(event) => setPreferenceDraft((current) => ({ ...current, developerRuntimes: { ...current.developerRuntimes, python: { ...current.developerRuntimes.python, executable: event.target.value } } }))} /></label>}
                  </div>
                  <div className="runtime-test-row"><button className="secondary-button" disabled={testingRuntime === 'python'} onClick={() => void testRuntime('python')}>{testingRuntime === 'python' ? t("检测中…") : t("检测 Python")}</button>{runtimeTestResults.python && <span className={runtimeTestResults.python.ok ? 'is-ok' : 'is-error'}>{runtimeTestResults.python.message}</span>}</div>
                </section>
              </div>
  )
}
