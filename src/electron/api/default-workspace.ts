import { lstat, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

export const DEFAULT_AGENTBOX_WORKSPACE_NAME = '.default-agent-box-workspace'

export function defaultAgentBoxWorkspacePath(executablePath: string): string {
  if (!isAbsolute(executablePath) || /[\r\n\0]/.test(executablePath)) {
    throw new Error('The application executable path is invalid.')
  }
  return join(dirname(executablePath), DEFAULT_AGENTBOX_WORKSPACE_NAME)
}

export async function ensureDefaultAgentBoxWorkspace(executablePath: string): Promise<string> {
  const workspacePath = defaultAgentBoxWorkspacePath(executablePath)
  await mkdir(workspacePath, { recursive: true, mode: 0o700 })
  const stats = await lstat(workspacePath)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('The default workspace path is not a regular directory.')
  }
  return workspacePath
}
