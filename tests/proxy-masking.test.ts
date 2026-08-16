import { describe, expect, it } from 'vitest'
import {
  isTrustedMainPage,
  maskProxyUrl,
  unmaskProxyUrl,
} from '../src/electron/ipc/register-ipc'

describe('IPC proxy URL masking (maskProxyUrl & unmaskProxyUrl)', () => {
  it('masks username and password in proxy URLs before exposing to renderer', () => {
    const rawUrl = 'https://alice:secret123@proxy.example.com:8443'
    const masked = maskProxyUrl(rawUrl)
    expect(masked).not.toContain('alice')
    expect(masked).not.toContain('secret123')
    expect(masked).toContain('***:***@proxy.example.com:8443')
  })

  it('masks username only if password is not provided', () => {
    const rawUrl = 'https://admin@proxy.example.com:8443'
    const masked = maskProxyUrl(rawUrl)
    expect(masked).not.toContain('admin')
    expect(masked).toContain('***@proxy.example.com:8443')
  })

  it('leaves proxy URLs without credentials unchanged', () => {
    expect(maskProxyUrl('http://127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
    expect(maskProxyUrl('https://proxy.example.com:443')).toBe(
      'https://proxy.example.com:443',
    )
  })

  it('handles empty string and invalid URLs gracefully without throwing', () => {
    expect(maskProxyUrl('')).toBe('')
    expect(maskProxyUrl('not a valid url')).toBe('not a valid url')
  })

  it('preserves the original unmasked URL when renderer submits back the masked string', () => {
    const original = 'https://alice:my_secret_password@proxy.example.com:8443'
    const masked = maskProxyUrl(original)

    // Renderer sends back the masked value unchanged
    const unmasked = unmaskProxyUrl(masked, original)
    expect(unmasked).toBe(original)
  })

  it('accepts updated credentials when the user enters a new proxy URL', () => {
    const original = 'https://alice:old_pass@proxy.example.com:8443'
    const changed = 'https://bob:new_pass@proxy.example.com:8443'

    const unmasked = unmaskProxyUrl(changed, original)
    expect(unmasked).toBe(changed)
  })
})

describe('IPC sender trust policy (isTrustedMainPage)', () => {
  it('validates against ELECTRON_RENDERER_URL when dev server is active', () => {
    const originalEnv = process.env.ELECTRON_RENDERER_URL
    try {
      process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173'
      expect(isTrustedMainPage('http://localhost:5173/')).toBe(true)
      expect(isTrustedMainPage('http://localhost:5173/index.html')).toBe(false)
      expect(isTrustedMainPage('http://attacker.com/')).toBe(false)
      expect(isTrustedMainPage('not a url')).toBe(false)
    } finally {
      process.env.ELECTRON_RENDERER_URL = originalEnv
    }
  })

  it('returns false for arbitrary remote web pages in production mode', () => {
    const originalEnv = process.env.ELECTRON_RENDERER_URL
    try {
      delete process.env.ELECTRON_RENDERER_URL
      expect(isTrustedMainPage('https://evil.com/phishing.html')).toBe(false)
      expect(isTrustedMainPage('http://localhost:3000')).toBe(false)
    } finally {
      process.env.ELECTRON_RENDERER_URL = originalEnv
    }
  })
})
