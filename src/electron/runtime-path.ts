import { posix, win32 } from 'node:path'

/**
 * Turns a path pasted from a platform file manager into the value that is
 * actually used and persisted. Windows "Copy as path" commonly includes a
 * pair of double quotes; absolute paths are also normalized to the native
 * separator/layout without changing command names such as `conda`.
 */
export function normalizeRuntimePathInput(value: unknown, platform: NodeJS.Platform = process.platform): string {
  if (typeof value !== 'string' || value.length > 4_096 || /[\r\n\0]/.test(value)) {
    throw new Error('Invalid runtime path')
  }

  let parsed = value.trim()
  if (parsed.length >= 2 && parsed.startsWith('"') && parsed.endsWith('"')) {
    parsed = parsed.slice(1, -1).trim()
  }

  const pathApi = platform === 'win32' ? win32 : posix
  return pathApi.isAbsolute(parsed) ? pathApi.normalize(parsed) : parsed
}
