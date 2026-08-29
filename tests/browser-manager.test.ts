import { describe, expect, it, vi } from 'vitest'
import type { AppSettings, BrowserCookieProfile } from '../src/shared/types'
import type { AppRepository } from '../src/electron/storage/app-repository'

const fakes = vi.hoisted(() => {
  class Emitter {
    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()

    on(event: string, listener: (...args: unknown[]) => void) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
      return this
    }

    once(event: string, listener: (...args: unknown[]) => void) {
      return this.on(event, listener)
    }

    emit(event: string, ...args: unknown[]) {
      for (const listener of this.listeners.get(event) ?? []) listener(...args)
    }
  }

  let nextContentsId = 1
  class FakeContents extends Emitter {
    id = nextContentsId++
    url = 'about:blank'
    title = ''
    destroyed = false
    loading = false
    history: string[] = []
    windowOpenHandler?: (details: { url: string }) => { action: string }
    debuggerAttached = false
    debugger = {
      isAttached: () => this.debuggerAttached,
      attach: () => {
        this.debuggerAttached = true
      },
      detach: () => {
        this.debuggerAttached = false
      },
      sendCommand: vi.fn(async () => ({})),
    }
    navigationHistory = {
      canGoBack: () => false,
      canGoForward: () => false,
      goBack: vi.fn(),
      goForward: vi.fn(),
    }

    setWindowOpenHandler(handler: (details: { url: string }) => { action: string }) {
      this.windowOpenHandler = handler
    }

    async loadURL(url: string) {
      this.loading = true
      this.emit('did-start-loading')
      this.url = url
      this.history.push(url)
      this.emit('did-navigate')
      this.loading = false
      this.emit('did-stop-loading')
    }

    getURL() {
      return this.url
    }

    getTitle() {
      return this.title
    }

    isLoading() {
      return this.loading
    }

    isDestroyed() {
      return this.destroyed
    }

    stop() {}
    reload() {}
    close() {
      this.destroyed = true
    }
  }

  class FakeView {
    webContents = new FakeContents()
    visible = false
    setBackgroundColor() {}
    setVisible(value: boolean) {
      this.visible = value
    }
    setBounds() {}
  }

  const cookieEmitter = new Emitter()
  const cookies = {
    on: cookieEmitter.on.bind(cookieEmitter),
    get: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
    set: vi.fn(async () => undefined),
  }
  const fakeSession = {
    cookies,
    setProxy: vi.fn(async () => undefined),
    resolveHost: vi.fn(async () => ({ endpoints: [{ address: '93.184.216.34', family: 'ipv4' }] })),
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    on: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn() },
    clearData: vi.fn(async () => undefined),
    clearCache: vi.fn(async () => undefined),
    closeAllConnections: vi.fn(async () => undefined),
  }
  return { FakeView, cookies, fakeSession }
})

vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\Downloads' },
  session: { fromPartition: () => fakes.fakeSession },
  WebContentsView: fakes.FakeView,
}))

const { BrowserManager } = await import('../src/electron/browser/browser-manager')

function repositoryMock(profile?: BrowserCookieProfile, settingsPatch: Partial<AppSettings> = {}) {
  const settings = {
    builtInBrowserEnabled: true,
    browserAllowHttpLoopback: false,
    browserPersistCookiesEnabled: Boolean(profile),
    browserAgentScreenshotsEnabled: false,
    browserFileUploadsEnabled: false,
    browserDownloadsEnabled: false,
    proxy: { mode: 'off', url: '' },
    ...settingsPatch,
  } as AppSettings
  return {
    getSettings: () => settings,
    getBrowserCookieProfile: vi.fn(() => profile),
    saveBrowserCookieProfile: vi.fn(async () => profile),
    clearBrowserCookieProfiles: vi.fn(async () => undefined),
  } as unknown as AppRepository
}

describe('BrowserManager multi-tab lifecycle', () => {
  it('creates, identifies, navigates, switches, and closes independent tabs', async () => {
    const manager = new BrowserManager(repositoryMock())
    const first = await manager.ensure('conversation-1')
    expect(first.tabs).toHaveLength(1)
    const firstTabId = first.activeTabId

    const second = await manager.newTab('conversation-1')
    expect(second.tabs).toHaveLength(2)
    expect(second.activeTabId).not.toBe(firstTabId)

    const navigated = await manager.navigate('conversation-1', 'https://example.com/', { tabId: firstTabId })
    expect(navigated.tabs.find((tab) => tab.id === firstTabId)?.url).toBe('https://example.com/')
    expect(navigated.activeTabId).toBe(second.activeTabId)

    expect((await manager.switchTab('conversation-1', firstTabId)).activeTabId).toBe(firstTabId)
    expect((await manager.closeTab('conversation-1', firstTabId)).tabs).toHaveLength(1)
    await manager.closeAll()
  })

  it('does not expose absolute download paths through browser events', async () => {
    const manager = new BrowserManager(repositoryMock(undefined, { browserDownloadsEnabled: true }))
    const events: unknown[] = []
    manager.onEvent((event) => events.push(event))
    const state = await manager.ensure('conversation-download')
    const tabId = state.activeTabId
    const internals = manager as unknown as {
      sessions: Map<string, { tabs: Map<string, { view: { webContents: { id: number } } }> }>
      handleDownload: (
        managed: unknown,
        event: { preventDefault: () => void },
        item: unknown,
        webContentsId: number,
      ) => void
    }
    const managed = internals.sessions.get('conversation-download')!
    const contentsId = managed.tabs.get(tabId)!.view.webContents.id
    const item = {
      getFilename: () => 'report.pdf',
      getReceivedBytes: () => 0,
      getTotalBytes: () => 100,
      setSavePath: vi.fn(),
      cancel: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
    }

    internals.handleDownload(managed, { preventDefault: vi.fn() }, item, contentsId)

    const downloadEvent = events.find(
      (event): event is { type: 'download'; download: Record<string, unknown> } =>
        typeof event === 'object' && event !== null && (event as { type?: string }).type === 'download',
    )
    expect(downloadEvent?.download).toMatchObject({ fileName: 'report.pdf', status: 'started' })
    expect(downloadEvent?.download).not.toHaveProperty('filePath')

    const agentPending = {
      tabId,
      directoryPath: 'C:\\workspace',
      relativeDirectory: 'downloads',
      resolve: vi.fn(),
      reject: vi.fn(),
      timer: setTimeout(() => undefined, 10_000),
      item,
    }
    ;(managed as unknown as { pendingDownload?: typeof agentPending }).pendingDownload = agentPending
    const secondItem = { ...item, cancel: vi.fn(), setSavePath: vi.fn() }
    internals.handleDownload(managed, { preventDefault: vi.fn() }, secondItem, contentsId)
    expect(secondItem.cancel).toHaveBeenCalledOnce()
    await manager.closeAll()
  })

  it('restores and re-encrypts a conversation cookie profile when persistence is enabled', async () => {
    const profile: BrowserCookieProfile = {
      conversationId: 'conversation-cookie',
      updatedAt: new Date().toISOString(),
      cookies: [
        {
          name: 'session',
          value: 'secret',
          domain: '.example.com',
          path: '/',
          secure: true,
          httpOnly: true,
          session: true,
          sameSite: 'lax',
        },
      ],
    }
    const repository = repositoryMock(profile)
    const saveProfile = vi.spyOn(repository, 'saveBrowserCookieProfile')
    const manager = new BrowserManager(repository)
    await manager.ensure(profile.conversationId)
    expect(fakes.cookies.set).toHaveBeenCalledWith(expect.objectContaining({ name: 'session', value: 'secret' }))

    fakes.cookies.get.mockResolvedValueOnce([
      {
        name: 'session',
        value: 'updated',
        domain: '.example.com',
        path: '/',
        secure: true,
        httpOnly: true,
        session: true,
        sameSite: 'lax',
      },
    ])
    await manager.close(profile.conversationId)
    expect(saveProfile).toHaveBeenCalledWith(
      profile.conversationId,
      expect.arrayContaining([expect.objectContaining({ name: 'session', value: 'updated' })]),
    )
  })
})
