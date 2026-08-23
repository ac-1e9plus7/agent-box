import { describe, expect, it } from 'vitest'
import {
  automaticShellCandidates,
  commandArguments,
  executeTerminalCommand,
  type ResolvedTerminalShell,
} from '../src/electron/api/terminal-shell'

describe('integrated terminal shell resolution', () => {
  it('orders Windows shells from modern PowerShell to cmd', () => {
    const candidates = automaticShellCandidates('win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' })
    expect(candidates.map((item) => item.kind)).toEqual(['powershell', 'powershell', 'cmd', 'cmd'])
    expect(candidates[0]?.executable).toBe('pwsh.exe')
    expect(candidates[2]?.executable).toBe('C:\\Windows\\System32\\cmd.exe')
  })

  it('prefers SHELL on macOS and Linux before platform fallbacks', () => {
    expect(automaticShellCandidates('darwin', { SHELL: '/opt/homebrew/bin/fish' })[0]).toMatchObject({
      executable: '/opt/homebrew/bin/fish',
      kind: 'fish',
    })
    expect(automaticShellCandidates('linux', { SHELL: '/bin/zsh' })[0]).toMatchObject({
      executable: '/bin/zsh',
      kind: 'posix',
    })
  })

  it('builds native command arguments for PowerShell, cmd, POSIX, and fish', () => {
    const shell = (kind: ResolvedTerminalShell['kind'], executable: string): ResolvedTerminalShell => ({
      executable,
      launchArgs: ['--startup'],
      kind,
      displayName: executable,
    })
    expect(commandArguments(shell('powershell', 'pwsh'), 'echo ok')).toEqual(['--startup', '-NonInteractive', '-Command', 'echo ok'])
    expect(commandArguments(shell('cmd', 'cmd'), 'echo ok')).toEqual(['--startup', '/s', '/c', 'echo ok'])
    expect(commandArguments(shell('posix', 'bash'), 'echo ok')).toEqual(['--startup', '-lc', 'echo ok'])
    expect(commandArguments(shell('fish', 'fish'), 'echo ok')).toEqual(['--startup', '-c', 'echo ok'])
  })

  it('supports a {command} argument template for custom shells', () => {
    expect(commandArguments({
      executable: 'custom-shell',
      launchArgs: ['run', '--expression={command}'],
      kind: 'custom',
      displayName: 'Custom',
    }, 'echo ok')).toEqual(['run', '--expression=echo ok'])
  })

  it('executes a command with the operating-system automatic shell', async () => {
    const result = await executeTerminalCommand(
      { mode: 'auto', executable: '', args: [] },
      process.platform === 'win32' ? 'echo agentbox-shell' : 'printf agentbox-shell',
    )
    expect(result.isError).toBe(false)
    expect(result.result).toContain('agentbox-shell')
  })
})
