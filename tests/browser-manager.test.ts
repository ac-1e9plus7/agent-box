import { describe, expect, it, vi } from 'vitest'
import type { AppSettings, BrowserCookieProfile } from '../src/shared/types'
import type { AppRepository } from '../src/electron/storage/app-repository'
import { DEFAULT_BROWSER_HOME_PAGE } from '../src/shared/browser-settings'

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
    stopHook?: () => void
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

    stop() {
      const hook = this.stopHook
      this.stopHook = undefined
      this.loading = false
      hook?.()
      this.emit('did-stop-loading')
    }
    reload() {}
    close() {
      this.destroyed = true
    }
  }

  class FakeView {
    webContents = new FakeContents()
    visible = false
    constructor() {
      views.push(this)
    }
    setBackgroundColor() {}
    setVisible(value: boolean) {
      this.visible = value
    }
    setBounds() {}
  }

  const views: FakeView[] = []
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
  const fromPartition = vi.fn(() => fakeSession)
  return { FakeView, cookies, fakeSession, fromPartition, views }
})

vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\Downloads' },
  session: { fromPartition: fakes.fromPartition },
  WebContentsView: fakes.FakeView,
}))

const { BrowserManager, formatChromiumProxyRules } = await import('../src/electron/browser/browser-manager')

function repositoryMock(profile?: BrowserCookieProfile, settingsPatch: Partial<AppSettings> = {}) {
  const settings = {
    builtInBrowserEnabled: true,
    browserHomePage: DEFAULT_BROWSER_HOME_PAGE,
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

function hostWindowMock() {
  const children = new Set<InstanceType<typeof fakes.FakeView>>()
  return {
    children,
    window: {
      isDestroyed: () => false,
      getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
      contentView: {
        addChildView: vi.fn((view: InstanceType<typeof fakes.FakeView>) => children.add(view)),
        removeChildView: vi.fn((view: InstanceType<typeof fakes.FakeView>) => children.delete(view)),
      },
    },
  }
}

describe('BrowserManager multi-tab lifecycle', () => {
  it('formats custom proxy URLs as Chromium proxy rules without paths or credentials', async () => {
    expect(formatChromiumProxyRules('http://127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
    expect(formatChromiumProxyRules('https://user:pass@proxy.example.com:8443/path?query=value#fragment')).toBe(
      'https://proxy.example.com:8443',
    )

    fakes.fakeSession.setProxy.mockClear()
    const manager = new BrowserManager(
      repositoryMock(undefined, { proxy: { mode: 'custom', url: 'http://127.0.0.1:7890' } }),
    )
    await manager.ensure('conversation-proxy')
    expect(fakes.fakeSession.setProxy).toHaveBeenLastCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'http://127.0.0.1:7890',
    })
    await manager.closeAll()
  })

  it('creates, identifies, navigates, switches, and closes independent tabs', async () => {
    const manager = new BrowserManager(repositoryMock())
    const first = await manager.ensure('conversation-1')
    expect(first.tabs).toHaveLength(1)
    expect(first.url).toBe(DEFAULT_BROWSER_HOME_PAGE)
    const firstTabId = first.activeTabId

    const second = await manager.newTab('conversation-1')
    expect(second.tabs).toHaveLength(2)
    expect(second.activeTabId).not.toBe(firstTabId)
    expect(second.url).toBe(DEFAULT_BROWSER_HOME_PAGE)

    const navigated = await manager.navigate('conversation-1', 'https://example.com/', { tabId: firstTabId })
    expect(navigated.tabs.find((tab) => tab.id === firstTabId)?.url).toBe('https://example.com/')
    expect(navigated.activeTabId).toBe(second.activeTabId)

    expect((await manager.switchTab('conversation-1', firstTabId)).activeTabId).toBe(firstTabId)
    expect((await manager.closeTab('conversation-1', firstTabId))?.tabs).toHaveLength(1)
    await manager.closeAll()
  })

  it('coalesces concurrent session initialization into one native tab', async () => {
    fakes.fromPartition.mockClear()
    fakes.fakeSession.setProxy.mockClear()
    fakes.views.length = 0
    const manager = new BrowserManager(repositoryMock())

    const [first, second] = await Promise.all([
      manager.ensure('conversation-single-flight'),
      manager.ensure('conversation-single-flight'),
    ])

    expect(first.sessionId).toBe(second.sessionId)
    expect(fakes.fromPartition).toHaveBeenCalledOnce()
    expect(fakes.fromPartition).toHaveBeenCalledWith(expect.stringMatching(/^agentbox-browser-/), { cache: true })
    expect(fakes.views).toHaveLength(1)
    expect(fakes.views[0]?.webContents.history).toEqual([DEFAULT_BROWSER_HOME_PAGE])
    await manager.navigate('conversation-single-flight', 'https://example.com/')
    expect(fakes.fakeSession.setProxy).toHaveBeenCalledOnce()
    await manager.closeAll()
  })

  it('keeps only the active visible tab attached to the host window', async () => {
    fakes.views.length = 0
    const manager = new BrowserManager(repositoryMock())
    const host = hostWindowMock()
    manager.attachHostWindow(host.window as never)
    const first = await manager.ensure('conversation-attached-tab')
    await manager.setViewState({
      conversationId: 'conversation-attached-tab',
      visible: true,
      bounds: { x: 0, y: 0, width: 600, height: 500 },
    })
    expect(host.children.size).toBe(1)

    const second = await manager.newTab('conversation-attached-tab')
    expect(host.children.size).toBe(1)
    expect(host.children.has(fakes.views[1]!)).toBe(true)

    await manager.switchTab('conversation-attached-tab', first.activeTabId)
    expect(host.children.size).toBe(1)
    expect(host.children.has(fakes.views[0]!)).toBe(true)

    await manager.setViewState({
      conversationId: 'conversation-attached-tab',
      visible: false,
      bounds: { x: 0, y: 0, width: 600, height: 500 },
    })
    expect(host.children.size).toBe(0)
    expect(second.tabs).toHaveLength(2)
    await manager.closeAll()
  })

  it('keeps a newer hidden view state when an older visible request finishes after slow navigation', async () => {
    fakes.views.length = 0
    fakes.fakeSession.resolveHost.mockClear()
    let resolveHost!: (value: { endpoints: Array<{ address: string; family: string }> }) => void
    fakes.fakeSession.resolveHost.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHost = resolve
        }),
    )
    const manager = new BrowserManager(repositoryMock())
    const host = hostWindowMock()
    manager.attachHostWindow(host.window as never)

    const initialization = manager.ensure('conversation-late-show')
    await manager.setViewState({
      conversationId: 'conversation-late-show',
      visible: true,
      bounds: { x: 10, y: 20, width: 600, height: 500 },
    })
    await vi.waitFor(() => expect(fakes.fakeSession.resolveHost).toHaveBeenCalled())
    await manager.setViewState({
      conversationId: 'conversation-late-show',
      visible: false,
      bounds: { x: 10, y: 20, width: 600, height: 500 },
    })
    resolveHost({ endpoints: [{ address: '93.184.216.34', family: 'ipv4' }] })

    await initialization
    expect(manager.getState('conversation-late-show')).toMatchObject({ visible: false })
    expect(fakes.views[0]?.visible).toBe(false)
    expect(host.children.size).toBe(0)
    await manager.closeAll()
  })

  it('hides, detaches, and destroys the native view before a slow Cookie snapshot finishes', async () => {
    fakes.views.length = 0
    const profile: BrowserCookieProfile = {
      conversationId: 'conversation-close-order',
      updatedAt: new Date().toISOString(),
      cookies: [],
    }
    const repository = repositoryMock(profile)
    let finishSave!: () => void
    const saveProfile = vi.spyOn(repository, 'saveBrowserCookieProfile').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSave = () => resolve(profile)
        }),
    )
    const manager = new BrowserManager(repository)
    const host = hostWindowMock()
    manager.attachHostWindow(host.window as never)
    await manager.ensure(profile.conversationId)
    await manager.setViewState({
      conversationId: profile.conversationId,
      visible: true,
      bounds: { x: 0, y: 0, width: 600, height: 500 },
    })
    expect(host.children.size).toBe(1)

    const closing = manager.close(profile.conversationId)
    await vi.waitFor(() => expect(saveProfile).toHaveBeenCalled())

    expect(host.children.size).toBe(0)
    expect(fakes.views[0]?.visible).toBe(false)
    expect(fakes.views[0]?.webContents.destroyed).toBe(true)
    finishSave()
    await closing
  })

  it('lets Stop interrupt a slow navigation without waiting behind the session queue', async () => {
    const manager = new BrowserManager(repositoryMock())
    const state = await manager.ensure('conversation-stop-navigation')
    const internals = manager as unknown as {
      sessions: Map<
        string,
        { tabs: Map<string, { view: { webContents: InstanceType<typeof fakes.FakeView>['webContents'] } }> }
      >
    }
    const contents = internals.sessions.get('conversation-stop-navigation')!.tabs.get(state.activeTabId)!.view
      .webContents
    let rejectLoad!: (error: Error) => void
    const loadUrl = vi.spyOn(contents, 'loadURL').mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          contents.loading = true
          rejectLoad = reject
          contents.stopHook = () => rejectLoad(new Error('ERR_ABORTED'))
          contents.emit('did-start-loading')
        }),
    )

    const navigation = manager.navigate('conversation-stop-navigation', 'https://slow.example/')
    await vi.waitFor(() => expect(loadUrl).toHaveBeenCalledWith('https://slow.example/'))
    await expect(manager.command('conversation-stop-navigation', 'stop')).resolves.toMatchObject({
      phase: 'ready',
      loading: false,
    })
    await expect(navigation).resolves.toMatchObject({ phase: 'ready', loading: false })
    await manager.closeAll()
  })

  it('applies the navigation timeout to DNS preflight and releases the queue', async () => {
    vi.useFakeTimers()
    try {
      const manager = new BrowserManager(repositoryMock())
      await manager.ensure('conversation-dns-timeout')
      fakes.fakeSession.resolveHost.mockClear()
      fakes.fakeSession.resolveHost.mockImplementationOnce(() => new Promise(() => undefined))

      const navigation = manager.navigate('conversation-dns-timeout', 'https://never-resolves.example/', {
        timeoutMs: 3_000,
      })
      const timedOut = expect(navigation).rejects.toMatchObject({ code: 'navigation_timeout' })
      await vi.advanceTimersByTimeAsync(3_000)

      await timedOut
      expect(manager.listTabs('conversation-dns-timeout')).toBeDefined()
      await manager.closeAll()
    } finally {
      vi.useRealTimers()
    }
  })

  it('coalesces concurrent subresource DNS checks for the same host', async () => {
    fakes.fakeSession.webRequest.onBeforeRequest.mockClear()
    const manager = new BrowserManager(repositoryMock())
    await manager.ensure('conversation-subresource-dns')
    const handler = fakes.fakeSession.webRequest.onBeforeRequest.mock.calls.find(
      ([candidate]) => typeof candidate === 'function',
    )?.[0] as ((details: { url: string }, callback: (result: { cancel: boolean }) => void) => void) | undefined
    expect(handler).toBeTypeOf('function')

    fakes.fakeSession.resolveHost.mockClear()
    let finishResolution!: () => void
    fakes.fakeSession.resolveHost.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishResolution = () => resolve({ endpoints: [{ address: '93.184.216.34', family: 'ipv4' }] })
        }),
    )
    const firstCallback = vi.fn()
    const secondCallback = vi.fn()
    handler!({ url: 'https://cdn.example/assets/one.js' }, firstCallback)
    handler!({ url: 'https://cdn.example/assets/two.css' }, secondCallback)

    expect(fakes.fakeSession.resolveHost).toHaveBeenCalledOnce()
    finishResolution()
    await vi.waitFor(() => {
      expect(firstCallback).toHaveBeenCalledWith({ cancel: false })
      expect(secondCallback).toHaveBeenCalledWith({ cancel: false })
    })
    await manager.closeAll()
  })

  it('opens the configured home page for sessions and new tabs, then closes the session with the final tab', async () => {
    const homePage = 'https://start.example/'
    const manager = new BrowserManager(repositoryMock(undefined, { browserHomePage: homePage }))

    const first = await manager.ensure('conversation-home')
    expect(first.url).toBe(homePage)

    const second = await manager.newTab('conversation-home')
    expect(second.url).toBe(homePage)
    const firstTabId = first.activeTabId
    const secondTabId = second.activeTabId

    await manager.closeTab('conversation-home', firstTabId)
    expect(await manager.closeTab('conversation-home', secondTabId)).toBeUndefined()
    expect(manager.getState('conversation-home')).toBeUndefined()
  })

  it('defers a user final-tab close until the Agent lease ends and supports cancellation', async () => {
    const manager = new BrowserManager(repositoryMock())
    const state = await manager.ensure('conversation-deferred-close')
    manager.beginAgentUse('conversation-deferred-close', 'request-1')

    const deferred = await manager.requestCloseTab('conversation-deferred-close', state.activeTabId)
    expect(deferred).toMatchObject({
      status: 'deferred',
      state: { agentActive: true, closePending: true },
    })
    expect(manager.getState('conversation-deferred-close')).toMatchObject({ closePending: true })

    expect(manager.cancelPendingClose('conversation-deferred-close')).toMatchObject({
      agentActive: true,
      closePending: undefined,
    })
    await manager.endAgentUse('conversation-deferred-close', 'request-1')
    expect(manager.getState('conversation-deferred-close')).toMatchObject({ agentActive: undefined })

    manager.beginAgentUse('conversation-deferred-close', 'request-2')
    manager.beginAgentUse('conversation-deferred-close', 'request-3')
    expect(await manager.requestClose('conversation-deferred-close')).toMatchObject({ status: 'deferred' })
    await manager.endAgentUse('conversation-deferred-close', 'request-2')
    expect(manager.getState('conversation-deferred-close')).toMatchObject({ agentActive: true, closePending: true })
    await manager.endAgentUse('conversation-deferred-close', 'request-3')
    expect(manager.getState('conversation-deferred-close')).toBeUndefined()
  })

  it('blocks individual user tab closes while the Agent lease is active', async () => {
    const manager = new BrowserManager(repositoryMock())
    const first = await manager.ensure('conversation-protected-tabs')
    await manager.newTab('conversation-protected-tabs')
    manager.beginAgentUse('conversation-protected-tabs', 'request-1')

    expect(await manager.requestCloseTab('conversation-protected-tabs', first.activeTabId)).toMatchObject({
      status: 'blocked',
      state: { agentActive: true, tabs: expect.arrayContaining([expect.objectContaining({ id: first.activeTabId })]) },
    })
    expect(manager.getState('conversation-protected-tabs')?.tabs).toHaveLength(2)

    await manager.endAgentUse('conversation-protected-tabs', 'request-1')
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
