/* global window */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'

const output = resolve('artifacts/smoke')
await mkdir(output, { recursive: true })
const profile = await mkdtemp(join(tmpdir(), 'agentbox-smoke-'))
const workspace = join(profile, 'workspace')
await mkdir(workspace)
const executable =
  process.env.AGENTBOX_SMOKE_EXECUTABLE ||
  resolve(
    process.platform === 'win32'
      ? 'release/win-unpacked/AgentBox.exe'
      : process.platform === 'darwin'
        ? `release/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/AgentBox.app/Contents/MacOS/AgentBox`
        : 'release/linux-unpacked/agentbox',
  )
assert.ok(existsSync(executable), `Packaged executable not found: ${executable}`)

let providerCalls = 0
let cookieIssued = false
const server = createServer(async (request, response) => {
  if (request.url === '/v1/chat/completions') {
    for await (const chunk of request) assert.ok(chunk.length <= 1024 * 1024)
    providerCalls += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const toolName =
      providerCalls === 1
        ? 'agentbox_browser_snapshot'
        : providerCalls === 2
          ? 'agentbox_browser_screenshot'
          : undefined
    response.end(
      `data: ${JSON.stringify({
        choices: [
          {
            delta: toolName
              ? {
                  tool_calls: [
                    { index: 0, id: `smoke-call-${providerCalls}`, function: { name: toolName, arguments: '{}' } },
                  ],
                }
              : { content: 'Smoke provider completed.' },
            finish_reason: toolName ? 'tool_calls' : 'stop',
          },
        ],
      })}\n\ndata: [DONE]\n\n`,
    )
    return
  }
  response.writeHead(200, {
    'content-type': 'text/html',
    ...(!cookieIssued ? { 'set-cookie': 'smoke_cookie=fixture; SameSite=Lax' } : {}),
  })
  cookieIssued = true
  response.end(
    '<!doctype html><html><head><title>AgentBox smoke fixture</title></head><body><h1>Local smoke fixture</h1><p>Native browser isolation test.</p><input aria-label="Search"><input type="password" autocomplete="current-password" aria-label="Password"><a href="/second" target="_blank">Second page</a></body></html>',
  )
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const address = server.address()
assert.ok(address && typeof address === 'object')
const baseUrl = `http://127.0.0.1:${address.port}`
const env = { ...process.env, AGENTBOX_SMOKE_USER_DATA: profile }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
let application
const rendererErrors = []
try {
  application = await electron.launch({
    executablePath: executable,
    env,
    args: process.platform === 'linux' ? ['--password-store=gnome-libsecret'] : [],
    timeout: 45_000,
  })
  const page = await application.firstWindow({ timeout: 30_000 })
  page.on('pageerror', (error) => rendererErrors.push(error.message))
  await page.waitForFunction(() => Boolean(window.agentbox), { timeout: 30_000 })
  const isolation = await application.evaluate(({ app, BrowserWindow, safeStorage }) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
    return {
      userData: app.getPath('userData'),
      secureStorage: safeStorage.isEncryptionAvailable(),
      sandbox: preferences.sandbox,
      contextIsolation: preferences.contextIsolation,
      nodeIntegration: preferences.nodeIntegration,
      electron: process.versions.electron,
    }
  })
  assert.equal(resolve(isolation.userData), resolve(profile))
  assert.equal(isolation.secureStorage, true)
  assert.equal(isolation.sandbox, true)
  assert.equal(isolation.contextIsolation, true)
  assert.equal(isolation.nodeIntegration, false)
  const fixture = await page.evaluate(
    async ({ baseUrl, workspace }) => {
      const api = window.agentbox
      await api.settings.update({
        language: 'en-US',
        builtInBrowserEnabled: true,
        browserAllowHttpLoopback: true,
        browserHomePage: baseUrl,
        browserPersistCookiesEnabled: true,
        browserAgentScreenshotsEnabled: true,
        mcpEnabled: false,
        mcpToolApprovalPolicy: 'full-access',
      })
      const provider = await api.providers.upsert({
        name: 'Smoke loopback',
        kind: 'cliproxy',
        baseUrl: `${baseUrl}/v1`,
        apiFormat: 'openai-chat-completions',
      })
      const model = await api.models.upsert({
        name: 'Smoke model',
        remoteId: 'smoke',
        providerId: provider.id,
        contextWindow: 128_000,
        maxOutputTokens: 256,
        supportsReasoning: false,
        defaultReasoningEnabled: false,
        defaultReasoningEffort: 'medium',
      })
      const now = new Date().toISOString()
      await api.conversations.save({
        id: 'smoke-conversation',
        title: 'Smoke conversation',
        modelId: model.id,
        agentMode: true,
        browserToolEnabled: true,
        reasoningEnabled: false,
        workingDirectory: workspace,
        createdAt: now,
        updatedAt: now,
        messages: Array.from({ length: 160 }, (_, index) => ({
          id: `smoke-message-${index}`,
          parentMessageId: index ? `smoke-message-${index - 1}` : null,
          role: index % 2 ? 'assistant' : 'user',
          modelId: model.id,
          content: `Smoke message ${index}\n\n${index % 2 ? '**Markdown** with $x^2$.' : 'Question'}`,
          createdAt: now,
        })),
        currentLeafId: 'smoke-message-159',
      })
      return { modelId: model.id }
    },
    { baseUrl, workspace },
  )
  await page.reload()
  await page.getByText('Smoke message 159', { exact: false }).waitFor({ timeout: 15_000 })
  const renderedRows = await page.locator('.message-row').count()
  assert.ok(renderedRows > 0 && renderedRows < 80, `Virtualized list rendered ${renderedRows} rows`)
  await page.screenshot({ path: join(output, 'conversation.png') })
  const first = await page.evaluate(() => window.agentbox.browser.ensure('smoke-conversation'))
  assert.equal(first.tabs.length, 1)
  const second = await page.evaluate(
    (url) => window.agentbox.browser.newTab('smoke-conversation', `${url}/second`),
    baseUrl,
  )
  assert.equal(second.tabs.length, 2)
  await page.evaluate(({ tabId }) => window.agentbox.browser.switchTab('smoke-conversation', tabId), {
    tabId: first.activeTabId,
  })
  await page.getByRole('button', { name: 'Browser', exact: true }).click()
  await page.getByRole('complementary', { name: 'Built-in browser' }).waitFor()
  const remoteIsolation = await application.evaluate(async ({ webContents }, url) => {
    const remote = webContents.getAllWebContents().find((contents) => contents.getURL() === `${url}/`)
    if (!remote) throw new Error('Native browser WebContents not found')
    const preferences = remote.getLastWebPreferences()
    return {
      sandbox: preferences.sandbox,
      contextIsolation: preferences.contextIsolation,
      nodeIntegration: preferences.nodeIntegration,
      persistent: remote.session.isPersistent(),
      bridge: await remote.executeJavaScript('typeof window.agentbox'),
    }
  }, baseUrl)
  assert.deepEqual(remoteIsolation, {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    persistent: false,
    bridge: 'undefined',
  })
  const agent = await page.evaluate(
    async ({ modelId, workspace }) =>
      new Promise((resolve, reject) => {
        let requestId
        const buffered = []
        const events = []
        const timer = setTimeout(() => {
          unsubscribe()
          reject(new Error('Agent fixture timeout'))
        }, 30_000)
        const processEvent = (event) => {
          if (event.requestId !== requestId) return
          events.push(event)
          if (event.type === 'error') {
            clearTimeout(timer)
            unsubscribe()
            reject(new Error(event.error.message))
          }
          if (event.type === 'done') {
            clearTimeout(timer)
            unsubscribe()
            resolve({
              text: events
                .filter((item) => item.type === 'text-delta')
                .map((item) => item.delta)
                .join(''),
              tools: events
                .filter((item) => item.type === 'tool-result')
                .map((item) => ({
                  name: item.toolName,
                  isError: Boolean(item.isError),
                  error: item.isError ? item.result : undefined,
                  hasImage: Boolean(item.resultContent?.some((part) => part.type === 'image')),
                  hasFixture: item.result.includes('Local smoke fixture'),
                })),
            })
          }
        }
        const unsubscribe = window.agentbox.chat.onEvent((event) => {
          if (requestId) processEvent(event)
          else buffered.push(event)
        })
        void window.agentbox.chat
          .stream({
            conversationId: 'smoke-conversation',
            modelId,
            responseMessageId: 'smoke-response',
            reasoningEnabled: false,
            agentMode: true,
            browserToolEnabled: true,
            mcpServerIds: [],
            skillIds: [],
            workingDirectory: workspace,
            messages: [
              {
                id: 'smoke-agent-input',
                role: 'user',
                content: 'Read the local fixture and take a screenshot.',
                createdAt: new Date().toISOString(),
              },
            ],
          })
          .then((result) => {
            requestId = result.requestId
            buffered.forEach(processEvent)
          }, reject)
      }),
    { modelId: fixture.modelId, workspace },
  )
  assert.equal(agent.text, 'Smoke provider completed.')
  await writeFile(join(output, 'agent-result.json'), JSON.stringify(agent, null, 2))
  assert.equal(agent.tools.length, 2)
  assert.ok(agent.tools.every((tool) => !tool.isError))
  assert.ok(agent.tools.some((tool) => tool.hasImage))
  assert.ok(agent.tools.some((tool) => tool.hasFixture))
  await page.evaluate(() => window.agentbox.browser.close('smoke-conversation'))
  await page.evaluate(() => window.agentbox.browser.ensure('smoke-conversation'))
  const cookieRestored = await application.evaluate(async ({ webContents }, url) => {
    const remote = webContents.getAllWebContents().find((contents) => contents.getURL() === `${url}/`)
    const cookies = await remote.session.cookies.get({ name: 'smoke_cookie' })
    return cookies.some((cookie) => cookie.value === 'fixture')
  }, baseUrl)
  assert.equal(cookieRestored, true)
  await page.evaluate(() => window.agentbox.data.clearConversations())
  assert.equal(await page.evaluate(async () => (await window.agentbox.conversations.list()).length), 0)
  assert.ok(
    (await page.evaluate(() => window.agentbox.providers.list())).some(
      (provider) => provider.name === 'Smoke loopback',
    ),
  )
  assert.equal(
    await application.evaluate(
      ({ webContents }, url) =>
        webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith(url)).length,
      baseUrl,
    ),
    0,
  )
  assert.deepEqual(rendererErrors, [])
  await application.close()
  application = undefined
  const encrypted = await readFile(join(profile, 'vault', 'user-data.v1.enc'), 'utf8')
  assert.ok(!encrypted.includes('Smoke loopback'))
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify(
      {
        ok: true,
        platform: process.platform,
        isolation,
        remoteIsolation,
        renderedRows,
        providerCalls,
        agent,
        cookieRestored,
        rendererErrors,
        profile,
      },
      null,
      2,
    ),
  )
  console.log(`Packaged Electron smoke passed (${process.platform}, Electron ${isolation.electron}).`)
} catch (error) {
  await writeFile(join(output, 'failure.txt'), error instanceof Error ? error.stack : String(error))
  throw error
} finally {
  if (application) await application.close().catch(() => undefined)
  await new Promise((done) => server.close(done))
}
