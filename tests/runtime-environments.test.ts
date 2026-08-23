import { describe, expect, it } from 'vitest'
import { pythonExecutableInEnvironment } from '../src/electron/api/runtime-environments'
import { normalizeDeveloperRuntimes } from '../src/electron/storage/settings-schema'

describe('developer runtime settings', () => {
  it('maps venv layouts across operating systems', () => {
    expect(pythonExecutableInEnvironment('C:\\repo\\.venv', 'win32')).toBe('C:\\repo\\.venv\\Scripts\\python.exe')
    expect(pythonExecutableInEnvironment('/repo/.venv', 'linux')).toBe('/repo/.venv/bin/python')
    expect(pythonExecutableInEnvironment('/repo/.venv', 'darwin')).toBe('/repo/.venv/bin/python')
  })

  it('accepts venv and Conda Python configurations', () => {
    expect(normalizeDeveloperRuntimes({
      jdk: { mode: 'auto', home: '' },
      go: { mode: 'auto', executable: '', root: '' },
      php: { mode: 'auto', executable: '' },
      python: { mode: 'venv', environment: '/repo/.venv', executable: '', condaExecutable: 'conda' },
    }).python.mode).toBe('venv')
    expect(normalizeDeveloperRuntimes({
      jdk: { mode: 'auto', home: '' },
      go: { mode: 'auto', executable: '', root: '' },
      php: { mode: 'auto', executable: '' },
      python: { mode: 'conda', environment: 'analytics', executable: '', condaExecutable: '/opt/conda/bin/conda' },
    }).python).toMatchObject({ mode: 'conda', environment: 'analytics' })
  })

  it('rejects incomplete explicit Python environments', () => {
    expect(() => normalizeDeveloperRuntimes({
      jdk: { mode: 'auto', home: '' },
      go: { mode: 'auto', executable: '', root: '' },
      php: { mode: 'auto', executable: '' },
      python: { mode: 'venv', environment: '', executable: '', condaExecutable: 'conda' },
    })).toThrow('Python venv 路径不能为空')
  })
})
