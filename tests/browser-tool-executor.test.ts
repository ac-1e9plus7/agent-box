import { describe, expect, it, vi } from 'vitest'
import { createBrowserTools } from '../src/shared/builtin-agent-tools'
import { BrowserToolExecutor } from '../src/electron/browser/browser-tool-executor'
import type { BrowserManager } from '../src/electron/browser/browser-manager'

function managerMock() {
  return {
    currentOrigin: vi.fn(() => 'https://example.com'),
    hasApprovedReadOrigin: vi.fn(() => false),
    grantReadOrigin: vi.fn(),
    navigate: vi.fn(async () => ({
      conversationId: 'conversation-1',
      sessionId: 'browser-1',
      phase: 'ready' as const,
      url: 'https://example.com/',
      title: 'Example',
      loading: false,
      visible: false,
      canGoBack: false,
      canGoForward: false,
      activeTabId: 'tab-1',
      tabs: [
        {
          id: 'tab-1',
          url: 'https://example.com/',
          title: 'Example',
          loading: false,
          canGoBack: false,
          canGoForward: false,
        },
      ],
    })),
    newTab: vi.fn(),
    switchTab: vi.fn(),
    closeTab: vi.fn(),
    listTabs: vi.fn(),
    ensure: vi.fn(),
    snapshot: vi.fn(),
    click: vi.fn(),
    typeText: vi.fn(),
    scroll: vi.fn(),
    screenshot: vi.fn(),
    upload: vi.fn(),
    download: vi.fn(),
    close: vi.fn(),
    getState: vi.fn(),
  }
}

describe('built-in browser tool executor', () => {
  it('requires an origin-scoped approval before sharing a page under the default policy', () => {
    const manager = managerMock()
    const executor = new BrowserToolExecutor(manager as unknown as BrowserManager)
    const snapshot = createBrowserTools().find((tool) => tool.name === 'snapshot')!

    const approval = executor.approvalFor('sensitive', 'conversation-1', snapshot, {}, false)

    expect(approval).toMatchObject({
      required: true,
      approvalKind: 'browser-share',
      approvalScope: { kind: 'browser-origin', origin: 'https://example.com' },
    })
    executor.applyDecision('conversation-1', approval, { decision: 'allow-browser-origin' })
    expect(manager.grantReadOrigin).toHaveBeenCalledWith('conversation-1', 'https://example.com')
  })

  it('keeps click and type sensitive even after an origin read grant', () => {
    const manager = managerMock()
    manager.hasApprovedReadOrigin.mockReturnValue(true)
    const executor = new BrowserToolExecutor(manager as unknown as BrowserManager)
    const click = createBrowserTools().find((tool) => tool.name === 'click')!
    const type = createBrowserTools().find((tool) => tool.name === 'type')!

    expect(executor.approvalFor('sensitive', 'conversation-1', click, {}, false).required).toBe(true)
    expect(executor.approvalFor('sensitive', 'conversation-1', type, {}, false).required).toBe(true)
  })

  it('does not begin a browser operation after request cancellation', async () => {
    const manager = managerMock()
    const executor = new BrowserToolExecutor(manager as unknown as BrowserManager)
    const click = createBrowserTools().find((tool) => tool.name === 'click')!
    const controller = new AbortController()
    controller.abort(new DOMException('cancelled', 'AbortError'))

    await expect(
      executor.execute('conversation-1', click, { snapshot_id: 'snapshot-1', ref: 'e1' }, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(manager.click).not.toHaveBeenCalled()
  })

  it('redacts navigation secrets in audit arguments while using the original URL for execution', async () => {
    const manager = managerMock()
    const executor = new BrowserToolExecutor(manager as unknown as BrowserManager)
    const navigate = createBrowserTools().find((tool) => tool.name === 'navigate')!
    const args = { url: 'https://example.com/callback?code=secret&view=1' }

    expect(executor.sanitizeArguments(navigate, args)).toEqual({
      url: 'https://example.com/callback?code=***&view=1',
    })
    await executor.execute('conversation-1', navigate, args, new AbortController().signal)
    expect(manager.navigate).toHaveBeenCalledWith(
      'conversation-1',
      'https://example.com/callback?code=secret&view=1',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('lists stable tab IDs so the Agent can target different pages', async () => {
    const manager = managerMock()
    manager.listTabs.mockReturnValue({
      conversationId: 'conversation-1',
      sessionId: 'browser-1',
      phase: 'ready',
      url: 'https://one.example/',
      title: 'One',
      loading: false,
      visible: true,
      canGoBack: false,
      canGoForward: false,
      activeTabId: 'tab-1',
      tabs: [
        {
          id: 'tab-1',
          url: 'https://one.example/',
          title: 'One',
          loading: false,
          canGoBack: false,
          canGoForward: false,
        },
        {
          id: 'tab-2',
          url: 'https://two.example/',
          title: 'Two',
          loading: false,
          canGoBack: false,
          canGoForward: false,
        },
      ],
    })
    const executor = new BrowserToolExecutor(manager as unknown as BrowserManager)
    const tabs = createBrowserTools().find((tool) => tool.name === 'tabs')!

    const result = await executor.execute('conversation-1', tabs, { action: 'list' }, new AbortController().signal)

    expect(result.structuredResult).toMatchObject({
      active_tab_id: 'tab-1',
      tabs: [{ tab_id: 'tab-1' }, { tab_id: 'tab-2' }],
    })
  })

  it('dispatches optional screenshot, upload, and download tools with tab and workspace scope', async () => {
    const manager = managerMock()
    manager.screenshot.mockResolvedValue({
      result: '{"action":"screenshot"}',
      structuredResult: { action: 'screenshot' },
      resultContent: [{ type: 'image', mimeType: 'image/jpeg', data: 'abc==' }],
    })
    manager.upload.mockResolvedValue({ result: '{"action":"upload"}', structuredResult: { action: 'upload' } })
    manager.download.mockResolvedValue({ result: '{"action":"download"}', structuredResult: { action: 'download' } })
    const executor = new BrowserToolExecutor(manager as unknown as BrowserManager)
    const tools = createBrowserTools({ screenshotsEnabled: true, uploadsEnabled: true, downloadsEnabled: true })

    await executor.execute(
      'conversation-1',
      tools.find((tool) => tool.name === 'screenshot')!,
      { tab_id: 'tab-2' },
      new AbortController().signal,
      'C:\\workspace',
    )
    await executor.execute(
      'conversation-1',
      tools.find((tool) => tool.name === 'upload')!,
      { tab_id: 'tab-2', snapshot_id: 'snapshot-2', ref: 'e1', paths: ['upload.txt'] },
      new AbortController().signal,
      'C:\\workspace',
    )
    await executor.execute(
      'conversation-1',
      tools.find((tool) => tool.name === 'download')!,
      { tab_id: 'tab-2', snapshot_id: 'snapshot-2', ref: 'e2', path: 'downloads/report.pdf' },
      new AbortController().signal,
      'C:\\workspace',
    )

    expect(manager.screenshot).toHaveBeenCalledWith('conversation-1', 'tab-2', undefined, expect.any(AbortSignal))
    expect(manager.upload).toHaveBeenCalledWith(
      'conversation-1',
      'C:\\workspace',
      'tab-2',
      'snapshot-2',
      'e1',
      ['upload.txt'],
      expect.any(AbortSignal),
    )
    expect(manager.download).toHaveBeenCalledWith(
      'conversation-1',
      'C:\\workspace',
      'tab-2',
      'snapshot-2',
      'e2',
      'downloads/report.pdf',
      expect.any(AbortSignal),
    )
  })
})
