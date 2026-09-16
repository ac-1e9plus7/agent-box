import { describe, expect, it } from 'vitest'
import {
  assertPublicBrowserDestination,
  isAllowedBrowserSubresource,
  isPrivateIpAddress,
  normalizeBrowserUrl,
  redactBrowserUrl,
} from '../src/electron/browser/browser-policy'
import type { Session } from 'electron'

describe('built-in browser URL policy', () => {
  it.each([
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '0:0:0:0:0:ffff:7f00:1',
    '::ffff:a00:1',
    '::ffff:ac10:1',
    '::ffff:c0a8:101',
    '::ffff:a9fe:101',
    '0:0:0:0:0:0:0:1',
    'FE80:0:0:0:0:0:0:1',
  ])('blocks canonical and expanded private address %s in URLs and DNS', async (address) => {
    expect(isPrivateIpAddress(address)).toBe(true)
    expect(() => normalizeBrowserUrl(`https://[${address}]/`, { allowHttpLoopback: false })).toThrow()
    const session = { resolveHost: async () => ({ endpoints: [{ address, family: 'ipv6' }] }) } as unknown as Session
    await expect(
      assertPublicBrowserDestination(new URL('https://example.com'), session, { allowHttpLoopback: false }),
    ).rejects.toThrow()
  })

  it('preserves public IPv6 and limits the opt-in to loopback addresses', () => {
    for (const address of ['2606:4700:4700::1111', '::ffff:808:808']) {
      expect(isPrivateIpAddress(address)).toBe(false)
      expect(normalizeBrowserUrl(`https://[${address}]/`, { allowHttpLoopback: false })).toBeTruthy()
    }
    expect(normalizeBrowserUrl('http://[::ffff:127.0.0.1]:3000', { allowHttpLoopback: true }).port).toBe('3000')
    expect(() => normalizeBrowserUrl('https://[::ffff:10.0.0.1]/', { allowHttpLoopback: true })).toThrow()
  })
  it('allows public HTTPS and rejects credentials or unsupported schemes', () => {
    expect(normalizeBrowserUrl('https://example.com/path', { allowHttpLoopback: false }).hostname).toBe('example.com')
    expect(() => normalizeBrowserUrl('https://user:pass@example.com/', { allowHttpLoopback: false })).toThrow(
      '用户名或密码',
    )
    expect(() => normalizeBrowserUrl('file:///etc/passwd', { allowHttpLoopback: false })).toThrow('仅允许 HTTPS')
    expect(() => normalizeBrowserUrl('javascript:alert(1)', { allowHttpLoopback: false })).toThrow('仅允许 HTTPS')
  })

  it('allows plain HTTP loopback only after the explicit developer opt-in', () => {
    expect(() => normalizeBrowserUrl('http://127.0.0.1:3000', { allowHttpLoopback: false })).toThrow('仅允许 HTTPS')
    expect(normalizeBrowserUrl('http://localhost:3000', { allowHttpLoopback: true }).port).toBe('3000')
    expect(() => normalizeBrowserUrl('http://example.com', { allowHttpLoopback: true })).toThrow('显式启用的环回 HTTP')
  })

  it('blocks literal private, link-local, multicast, and mapped addresses', () => {
    for (const address of ['10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.1.1', '127.0.0.1', '::1', 'fc00::1']) {
      expect(isPrivateIpAddress(address)).toBe(true)
    }
    expect(isPrivateIpAddress('8.8.8.8')).toBe(false)
    expect(() => normalizeBrowserUrl('https://192.168.1.1', { allowHttpLoopback: false })).toThrow('本地网络地址')
  })

  it('redacts URL credentials, fragments, and sensitive query parameters before persistence', () => {
    expect(redactBrowserUrl('https://user:pass@example.com/cb?code=secret&view=full#token')).toBe(
      'https://example.com/cb?code=***&view=full',
    )
  })

  it('permits data and blob only as subresources while still filtering network URLs', () => {
    expect(isAllowedBrowserSubresource('data:image/png;base64,AA==', { allowHttpLoopback: false })).toBe(true)
    expect(isAllowedBrowserSubresource('blob:https://example.com/id', { allowHttpLoopback: false })).toBe(true)
    expect(isAllowedBrowserSubresource('http://192.168.1.10/a.js', { allowHttpLoopback: false })).toBe(false)
  })

  it('rejects public hostnames when Chromium DNS resolution reaches a private address', async () => {
    const browserSession = {
      resolveHost: async () => ({ endpoints: [{ address: '192.168.10.2', family: 'ipv4' as const }] }),
    } as unknown as Session

    await expect(
      assertPublicBrowserDestination(new URL('https://rebinding.example'), browserSession, {
        allowHttpLoopback: false,
      }),
    ).rejects.toThrow('本地网络地址')
  })
})
