import { describe, expect, it } from 'vitest'
import { buildBrowserWorldScript } from '../src/electron/browser/browser-snapshot-script'

describe('browser isolated-world script builder', () => {
  it('encodes model-supplied text as data instead of interpolating executable JavaScript', () => {
    const untrusted = '"); globalThis.compromised = true; //'
    const script = buildBrowserWorldScript({
      action: 'type',
      snapshotId: 'snapshot-1',
      ref: 'e1',
      text: untrusted,
      mode: 'replace',
    })

    expect(script).not.toContain(untrusted)
    expect(script).not.toContain('globalThis.compromised')
    expect(script).toContain('browserWorldRuntime')
  })
})
