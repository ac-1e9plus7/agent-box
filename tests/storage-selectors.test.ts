import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}))
const { EncryptedStore } = await import('../src/electron/storage/encrypted-store')

it('copies only the selected field and isolates nested mutations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentbox-selector-'))
  const state = { settings: { proxy: { mode: 'off' } }, messages: ['x'.repeat(1_000_000)] }
  const store = new EncryptedStore(
    directory,
    () => state,
    (value) => value as typeof state,
  )
  try {
    await store.initialize({ allowLegacyMigration: false })
    const clone = vi.spyOn(globalThis, 'structuredClone')
    const settings = store.readField('settings')
    expect(clone.mock.calls[0]?.[0]).toEqual(state.settings)
    settings.proxy.mode = 'changed'
    expect(store.readField('settings').proxy.mode).toBe('off')
    clone.mockRestore()
  } finally {
    store.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})
