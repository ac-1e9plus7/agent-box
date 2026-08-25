import { describe, expect, it } from 'vitest'
import {
  parseCondaEnvironments,
  pythonExecutableInCondaEnvironment,
  pythonExecutableInEnvironment,
} from '../src/electron/api/runtime-environments'
import { normalizeRuntimePathInput } from '../src/electron/runtime-path'
import { normalizeDeveloperRuntimes } from '../src/electron/storage/settings-schema'

describe('developer runtime settings', () => {
  it('maps venv layouts across operating systems', () => {
    expect(pythonExecutableInEnvironment('C:\\repo\\.venv', 'win32')).toBe('C:\\repo\\.venv\\Scripts\\python.exe')
    expect(pythonExecutableInEnvironment('/repo/.venv', 'linux')).toBe('/repo/.venv/bin/python')
    expect(pythonExecutableInEnvironment('/repo/.venv', 'darwin')).toBe('/repo/.venv/bin/python')
  })

  it('uses the Conda-specific Python layout on Windows', () => {
    expect(pythonExecutableInCondaEnvironment('C:\\envs\\analytics', 'win32')).toBe('C:\\envs\\analytics\\python.exe')
    expect(pythonExecutableInCondaEnvironment('/envs/analytics', 'linux')).toBe('/envs/analytics/bin/python')
  })

  it('parses quoted Windows Explorer paths into normalized native paths', () => {
    expect(normalizeRuntimePathInput('  "C:\\SDK\\Python\\..\\Conda\\conda.exe"  ', 'win32')).toBe(
      'C:\\SDK\\Conda\\conda.exe',
    )
    expect(normalizeRuntimePathInput('conda', 'win32')).toBe('conda')
  })

  it('maps Conda JSON to selectable names and actual prefix paths', () => {
    expect(
      parseCondaEnvironments(
        JSON.stringify({
          root_prefix: 'C:\\ProgramData\\miniconda3',
          active_prefix: 'C:\\Users\\dev\\.conda\\envs\\analytics',
          envs: [
            'C:\\ProgramData\\miniconda3',
            'C:\\Users\\dev\\.conda\\envs\\analytics',
            'c:\\users\\dev\\.conda\\envs\\analytics',
          ],
        }),
        'win32',
      ),
    ).toEqual([
      { name: 'base', path: 'C:\\ProgramData\\miniconda3', active: false },
      { name: 'analytics', path: 'C:\\Users\\dev\\.conda\\envs\\analytics', active: true },
    ])
  })

  it('accepts venv and Conda Python configurations', () => {
    expect(
      normalizeDeveloperRuntimes({
        jdk: { mode: 'auto', home: '' },
        go: { mode: 'auto', executable: '', root: '' },
        php: { mode: 'auto', executable: '' },
        python: { mode: 'venv', environment: '/repo/.venv', executable: '', condaExecutable: 'conda' },
      }).python.mode,
    ).toBe('venv')
    expect(
      normalizeDeveloperRuntimes({
        jdk: { mode: 'auto', home: '' },
        go: { mode: 'auto', executable: '', root: '' },
        php: { mode: 'auto', executable: '' },
        python: { mode: 'conda', environment: 'analytics', executable: '', condaExecutable: '/opt/conda/bin/conda' },
      }).python,
    ).toMatchObject({ mode: 'conda', environment: 'analytics' })
  })

  it('persists parsed Windows runtime paths instead of quoted input', () => {
    expect(
      normalizeDeveloperRuntimes({
        jdk: { mode: 'auto', home: '' },
        go: { mode: 'auto', executable: '', root: '' },
        php: { mode: 'auto', executable: '' },
        python: {
          mode: 'conda',
          environment: '"C:\\Users\\dev\\.conda\\envs\\analytics"',
          executable: '',
          condaExecutable: '"C:\\ProgramData\\miniconda3\\Scripts\\conda.exe"',
        },
      }).python,
    ).toMatchObject({
      environment: 'C:\\Users\\dev\\.conda\\envs\\analytics',
      condaExecutable: 'C:\\ProgramData\\miniconda3\\Scripts\\conda.exe',
    })
  })

  it('rejects incomplete explicit Python environments', () => {
    expect(() =>
      normalizeDeveloperRuntimes({
        jdk: { mode: 'auto', home: '' },
        go: { mode: 'auto', executable: '', root: '' },
        php: { mode: 'auto', executable: '' },
        python: { mode: 'venv', environment: '', executable: '', condaExecutable: 'conda' },
      }),
    ).toThrow('Python venv 路径不能为空')
  })
})
