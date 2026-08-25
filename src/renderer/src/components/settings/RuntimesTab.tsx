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
  const [runtimeTestResults, setRuntimeTestResults] = useState<
    Partial<Record<DeveloperRuntimeKind, RuntimeTestResult>>
  >({})
  const [testingRuntime, setTestingRuntime] = useState<DeveloperRuntimeKind | null>(null)
  const [condaEnvironmentResult, setCondaEnvironmentResult] = useState<CondaEnvironmentListResult | null>(null)
  const [loadingCondaEnvironments, setLoadingCondaEnvironments] = useState(false)
  const [condaEnvironmentRefresh, setCondaEnvironmentRefresh] = useState(0)

  useEffect(() => {
    if (preferenceDraft.developerRuntimes.python.mode !== 'conda' || !onListCondaEnvironments) {
      setCondaEnvironmentResult(null)
      setLoadingCondaEnvironments(false)
      return
    }

    let cancelled = false
    const timer = window.setTimeout(() => {
      setLoadingCondaEnvironments(true)
      void onListCondaEnvironments(preferenceDraft.developerRuntimes.python.condaExecutable.trim() || 'conda')
        .then((result) => {
          if (cancelled) return
          setCondaEnvironmentResult(result)
          if (!result.ok || result.environments.length === 0) return

          setPreferenceDraft((current) => {
            const configured = current.developerRuntimes.python.environment
            const matched =
              result.environments.find(
                (environment) => environment.path === configured || environment.name === configured,
              ) ??
              result.environments.find(
                (environment) =>
                  environment.path.toLowerCase() === configured.toLowerCase() ||
                  environment.name.toLowerCase() === configured.toLowerCase(),
              )
            if (configured && !matched) return current
            const environment =
              matched ?? result.environments.find((candidate) => candidate.active) ?? result.environments[0]
            if (!environment || configured === environment.path) return current
            return {
              ...current,
              developerRuntimes: {
                ...current.developerRuntimes,
                python: { ...current.developerRuntimes.python, environment: environment.path },
              },
            }
          })
        })
        .catch((error: unknown) => {
          if (cancelled) return
          setCondaEnvironmentResult({
            ok: false,
            condaExecutable: preferenceDraft.developerRuntimes.python.condaExecutable,
            environments: [],
            message: error instanceof Error ? error.message : t('Failed to read Conda environments.'),
          })
        })
        .finally(() => {
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
        <h3>{t('Runtime resolution')}</h3>
        <p className="runtime-intro">
          {t(
            'Automatic mode first checks the current conversation’s working directory, then falls back to environment variables and PATH. The resolved environment is injected into the integrated terminal and used by code-execution tools.',
          )}
        </p>
      </section>

      {(['jdk', 'go', 'php'] as const).map((kind) => {
        const runtime = preferenceDraft.developerRuntimes[kind]
        const label = kind === 'jdk' ? 'JDK' : kind === 'go' ? 'Go' : 'PHP'
        const result = runtimeTestResults[kind]
        return (
          <section className="settings-card runtime-card" key={kind}>
            <div className="runtime-card-header">
              <div>
                <h3>{label}</h3>
                <small>
                  {kind === 'jdk'
                    ? t('Provide JAVA_HOME and java')
                    : kind === 'go'
                      ? t('Provides go with optional GOROOT')
                      : t('Provide php CLI')}
                </small>
              </div>
              <div className="segmented-control">
                {(['auto', 'custom'] as const).map((mode) => (
                  <button
                    className={runtime.mode === mode ? 'is-active' : ''}
                    key={mode}
                    onClick={() =>
                      setPreferenceDraft((current) => ({
                        ...current,
                        developerRuntimes: {
                          ...current.developerRuntimes,
                          [kind]: { ...current.developerRuntimes[kind], mode },
                        },
                      }))
                    }
                  >
                    {mode === 'auto' ? t('Auto') : t('Specify')}
                  </button>
                ))}
              </div>
            </div>
            {runtime.mode === 'custom' && (
              <div className="runtime-fields">
                {kind === 'jdk' && (
                  <label>
                    <FieldLabel hint={t('JDK root directory, which must contain bin/java')}>JAVA_HOME</FieldLabel>
                    <div className="runtime-path-input">
                      <input
                        className="mono-input"
                        value={preferenceDraft.developerRuntimes.jdk.home}
                        onChange={(event) =>
                          setPreferenceDraft((current) => ({
                            ...current,
                            developerRuntimes: {
                              ...current.developerRuntimes,
                              jdk: { ...current.developerRuntimes.jdk, home: event.target.value },
                            },
                          }))
                        }
                      />
                      <button
                        className="secondary-button"
                        onClick={async () => {
                          const path = await chooseDirectory(preferenceDraft.developerRuntimes.jdk.home)
                          if (path)
                            setPreferenceDraft((current) => ({
                              ...current,
                              developerRuntimes: {
                                ...current.developerRuntimes,
                                jdk: { ...current.developerRuntimes.jdk, home: path },
                              },
                            }))
                        }}
                      >
                        <Icon name="folder" size={13} />
                      </button>
                    </div>
                  </label>
                )}
                {kind === 'go' && (
                  <>
                    <label>
                      <FieldLabel hint={t('Path to go or go.exe; use GOROOT/bin/go when left blank')}>
                        {t('Go executable')}
                      </FieldLabel>
                      <input
                        className="mono-input"
                        value={preferenceDraft.developerRuntimes.go.executable}
                        onChange={(event) =>
                          setPreferenceDraft((current) => ({
                            ...current,
                            developerRuntimes: {
                              ...current.developerRuntimes,
                              go: { ...current.developerRuntimes.go, executable: event.target.value },
                            },
                          }))
                        }
                      />
                    </label>
                    <label>
                      <FieldLabel hint={t('Optional Go installation root directory')}>GOROOT</FieldLabel>
                      <div className="runtime-path-input">
                        <input
                          className="mono-input"
                          value={preferenceDraft.developerRuntimes.go.root}
                          onChange={(event) =>
                            setPreferenceDraft((current) => ({
                              ...current,
                              developerRuntimes: {
                                ...current.developerRuntimes,
                                go: { ...current.developerRuntimes.go, root: event.target.value },
                              },
                            }))
                          }
                        />
                        <button
                          className="secondary-button"
                          onClick={async () => {
                            const path = await chooseDirectory(preferenceDraft.developerRuntimes.go.root)
                            if (path)
                              setPreferenceDraft((current) => ({
                                ...current,
                                developerRuntimes: {
                                  ...current.developerRuntimes,
                                  go: { ...current.developerRuntimes.go, root: path },
                                },
                              }))
                          }}
                        >
                          <Icon name="folder" size={13} />
                        </button>
                      </div>
                    </label>
                  </>
                )}
                {kind === 'php' && (
                  <label>
                    <FieldLabel hint={t('Path to php or php.exe')}>{t('PHP executable')}</FieldLabel>
                    <input
                      className="mono-input"
                      value={preferenceDraft.developerRuntimes.php.executable}
                      onChange={(event) =>
                        setPreferenceDraft((current) => ({
                          ...current,
                          developerRuntimes: {
                            ...current.developerRuntimes,
                            php: { ...current.developerRuntimes.php, executable: event.target.value },
                          },
                        }))
                      }
                    />
                  </label>
                )}
              </div>
            )}
            <div className="runtime-test-row">
              <button
                className="secondary-button"
                disabled={testingRuntime === kind}
                onClick={() => void testRuntime(kind)}
              >
                {testingRuntime === kind ? t('Detecting…') : t('Detect {value0}', { value0: label })}
              </button>
              {result && <span className={result.ok ? 'is-ok' : 'is-error'}>{result.message}</span>}
            </div>
          </section>
        )
      })}

      <section className="settings-card runtime-card">
        <div className="runtime-card-header">
          <div>
            <h3>Python</h3>
            <small>{t('Supports project .venv, standard venv, Conda, and custom interpreters')}</small>
          </div>
        </div>
        <div className="python-runtime-modes">
          {(['auto', 'system', 'venv', 'conda', 'custom'] as const).map((mode) => (
            <button
              className={preferenceDraft.developerRuntimes.python.mode === mode ? 'is-active' : ''}
              key={mode}
              onClick={() =>
                setPreferenceDraft((current) => ({
                  ...current,
                  developerRuntimes: {
                    ...current.developerRuntimes,
                    python: { ...current.developerRuntimes.python, mode },
                  },
                }))
              }
            >
              {mode === 'auto'
                ? t('Auto')
                : mode === 'system'
                  ? t('System')
                  : mode === 'venv'
                    ? 'venv'
                    : mode === 'conda'
                      ? 'Conda'
                      : t('Specify interpreter')}
            </button>
          ))}
        </div>
        <div className="runtime-fields">
          {preferenceDraft.developerRuntimes.python.mode === 'auto' && (
            <p className="runtime-mode-hint">
              {t(
                'Checks .venv/venv in the working directory, VIRTUAL_ENV, and CONDA_PREFIX in order, then falls back to system Python 3.',
              )}
            </p>
          )}
          {preferenceDraft.developerRuntimes.python.mode === 'system' && (
            <label>
              <FieldLabel hint={t('Optional; automatically tries python3/python/py -3 when left empty')}>
                {t('System Python executable')}
              </FieldLabel>
              <input
                className="mono-input"
                value={preferenceDraft.developerRuntimes.python.executable}
                onChange={(event) =>
                  setPreferenceDraft((current) => ({
                    ...current,
                    developerRuntimes: {
                      ...current.developerRuntimes,
                      python: { ...current.developerRuntimes.python, executable: event.target.value },
                    },
                  }))
                }
              />
            </label>
          )}
          {preferenceDraft.developerRuntimes.python.mode === 'venv' && (
            <label>
              <FieldLabel
                hint={t('venv root directory; Windows uses Scripts/python.exe, while macOS/Linux uses bin/python')}
              >
                {t('venv path')}
              </FieldLabel>
              <div className="runtime-path-input">
                <input
                  className="mono-input"
                  value={preferenceDraft.developerRuntimes.python.environment}
                  onChange={(event) =>
                    setPreferenceDraft((current) => ({
                      ...current,
                      developerRuntimes: {
                        ...current.developerRuntimes,
                        python: { ...current.developerRuntimes.python, environment: event.target.value },
                      },
                    }))
                  }
                />
                <button
                  className="secondary-button"
                  onClick={async () => {
                    const path = await chooseDirectory(preferenceDraft.developerRuntimes.python.environment)
                    if (path)
                      setPreferenceDraft((current) => ({
                        ...current,
                        developerRuntimes: {
                          ...current.developerRuntimes,
                          python: { ...current.developerRuntimes.python, environment: path },
                        },
                      }))
                  }}
                >
                  <Icon name="folder" size={13} />
                </button>
              </div>
            </label>
          )}
          {preferenceDraft.developerRuntimes.python.mode === 'conda' && (
            <>
              <label>
                <FieldLabel hint={t('Default conda; you can also paste the full path to conda.exe/conda')}>
                  {t('Conda executable')}
                </FieldLabel>
                <div className="runtime-path-input">
                  <input
                    className="mono-input"
                    placeholder={t('conda or C:\\\\...\\\\conda.exe')}
                    value={preferenceDraft.developerRuntimes.python.condaExecutable}
                    onChange={(event) =>
                      setPreferenceDraft((current) => ({
                        ...current,
                        developerRuntimes: {
                          ...current.developerRuntimes,
                          python: {
                            ...current.developerRuntimes.python,
                            condaExecutable: event.target.value,
                          },
                        },
                      }))
                    }
                  />
                  <button
                    aria-label={t('Refresh Conda environments')}
                    className="secondary-button"
                    disabled={loadingCondaEnvironments}
                    onClick={() => setCondaEnvironmentRefresh((current) => current + 1)}
                    title={t('Reload Conda environments')}
                    type="button"
                  >
                    <Icon name="refresh" size={13} />
                  </button>
                </div>
                <small
                  className={`runtime-field-status ${condaEnvironmentResult?.ok ? 'is-ok' : condaEnvironmentResult ? 'is-error' : ''}`}
                >
                  {loadingCondaEnvironments
                    ? t('Loading Conda environments…')
                    : (condaEnvironmentResult?.message ?? t('Enter a path to detect Conda automatically.'))}
                </small>
              </label>
              <label>
                <FieldLabel
                  hint={t('After Conda is detected, select an environment; its resolved prefix path will be saved')}
                >
                  {t('Conda environment')}
                </FieldLabel>
                {condaEnvironmentResult?.ok && condaEnvironmentResult.environments.length > 0 ? (
                  <select
                    className="mono-input runtime-environment-select"
                    value={preferenceDraft.developerRuntimes.python.environment}
                    onChange={(event) =>
                      setPreferenceDraft((current) => ({
                        ...current,
                        developerRuntimes: {
                          ...current.developerRuntimes,
                          python: {
                            ...current.developerRuntimes.python,
                            environment: event.target.value,
                          },
                        },
                      }))
                    }
                  >
                    {preferenceDraft.developerRuntimes.python.environment &&
                      !condaEnvironmentResult.environments.some(
                        (environment) => environment.path === preferenceDraft.developerRuntimes.python.environment,
                      ) && (
                        <option value={preferenceDraft.developerRuntimes.python.environment}>
                          {t('Current configuration (not in environment list) — {value0}', {
                            value0: preferenceDraft.developerRuntimes.python.environment,
                          })}
                        </option>
                      )}
                    {condaEnvironmentResult.environments.map((environment) => (
                      <option key={environment.path} value={environment.path}>
                        {environment.name}
                        {environment.active ? t('(current)') : ''} — {environment.path}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="mono-input"
                    placeholder={t('Environment name or absolute prefix path')}
                    value={preferenceDraft.developerRuntimes.python.environment}
                    onChange={(event) =>
                      setPreferenceDraft((current) => ({
                        ...current,
                        developerRuntimes: {
                          ...current.developerRuntimes,
                          python: {
                            ...current.developerRuntimes.python,
                            environment: event.target.value,
                          },
                        },
                      }))
                    }
                  />
                )}
              </label>
            </>
          )}
          {preferenceDraft.developerRuntimes.python.mode === 'custom' && (
            <label>
              <FieldLabel>{t('Python executable')}</FieldLabel>
              <input
                className="mono-input"
                value={preferenceDraft.developerRuntimes.python.executable}
                onChange={(event) =>
                  setPreferenceDraft((current) => ({
                    ...current,
                    developerRuntimes: {
                      ...current.developerRuntimes,
                      python: { ...current.developerRuntimes.python, executable: event.target.value },
                    },
                  }))
                }
              />
            </label>
          )}
        </div>
        <div className="runtime-test-row">
          <button
            className="secondary-button"
            disabled={testingRuntime === 'python'}
            onClick={() => void testRuntime('python')}
          >
            {testingRuntime === 'python' ? t('Detecting…') : t('Detect Python')}
          </button>
          {runtimeTestResults.python && (
            <span className={runtimeTestResults.python.ok ? 'is-ok' : 'is-error'}>
              {runtimeTestResults.python.message}
            </span>
          )}
        </div>
      </section>
    </div>
  )
}
