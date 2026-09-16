import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
const { EncryptedStore } = await import('../../src/electron/storage/encrypted-store')

it('records synthetic whole-Vault versus settings-selector latency at 1/10/50 MiB', async () => {
  const results = []
  for (const sizeMiB of [1, 10, 50]) {
    const directory = await mkdtemp(join(tmpdir(), 'agentbox-benchmark-'))
    const state = {
      settings: { browserEnabled: true, proxy: { mode: 'off' } },
      history: 'x'.repeat(sizeMiB * 1024 * 1024),
    }
    const store = new EncryptedStore(
      directory,
      () => state,
      (value) => value as typeof state,
    )
    try {
      await store.initialize({ allowLegacyMigration: false })
      const iterations = 20
      let start = performance.now()
      for (let i = 0; i < iterations; i++) expect(store.read().settings.browserEnabled).toBe(true)
      const wholeVaultMs = performance.now() - start
      start = performance.now()
      for (let i = 0; i < iterations; i++) expect(store.readField('settings').browserEnabled).toBe(true)
      const selectedFieldMs = performance.now() - start
      start = performance.now()
      await store.mutate((draft) => {
        draft.settings.browserEnabled = false
      })
      const saveMs = performance.now() - start
      results.push({ sizeMiB, iterations, wholeVaultMs, selectedFieldMs, saveMs })
    } finally {
      store.destroy()
      await rm(directory, { recursive: true, force: true })
    }
  }
  await mkdir('artifacts/quality-review', { recursive: true })
  await writeFile(
    'artifacts/quality-review/storage-performance.json',
    JSON.stringify({ node: process.version, results }, null, 2),
  )
  console.table(results)
})
