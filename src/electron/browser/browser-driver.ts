import type { WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { BrowserError } from './browser-errors'
import {
  buildBrowserWorldScript,
  type BrowserActionPayload,
  type BrowserResolvedElement,
  type BrowserSnapshotPayload,
} from './browser-snapshot-script'
import { t } from '../../shared/i18n'

const BROWSER_ISOLATED_WORLD_ID = 128_731

export class BrowserDriver {
  private fileChooserAllowed = false

  constructor(private readonly contents: WebContents) {}

  async setFileChooserAllowed(allowed: boolean): Promise<void> {
    this.fileChooserAllowed = allowed
    try {
      if (!this.contents.debugger.isAttached()) this.contents.debugger.attach('1.3')
      await this.contents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: !allowed })
    } catch {
      if (allowed) return
      throw new BrowserError(t('The browser file-upload policy could not be applied.'), 'browser_operation_failed')
    }
  }

  async captureSnapshot(snapshotId: string): Promise<BrowserSnapshotPayload> {
    const result = await this.run({ action: 'snapshot', snapshotId })
    if (!isSnapshotPayload(result)) {
      throw new BrowserError(t('The browser page snapshot was invalid.'), 'browser_operation_failed')
    }
    return result
  }

  async click(snapshotId: string, ref: string, signal?: AbortSignal): Promise<BrowserResolvedElement> {
    const result = await withAbort(() => this.run({ action: 'resolve', snapshotId, ref }), signal)
    if (!isResolvedElement(result)) {
      throw new BrowserError(t('The browser element could not be resolved.'), 'element_not_found')
    }
    if (result.inputType === 'file' || result.sensitive) {
      throw new BrowserError(t('The Agent cannot operate sensitive browser fields.'), 'sensitive_input')
    }
    try {
      throwIfAborted(signal)
      if (!this.contents.debugger.isAttached()) this.contents.debugger.attach('1.3')
      await withAbort(
        () => this.contents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true }),
        signal,
      ).catch(() => undefined)
      await withAbort(
        () =>
          this.contents.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: result.x,
            y: result.y,
          }),
        signal,
      )
      await withAbort(
        () =>
          this.contents.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: result.x,
            y: result.y,
            button: 'left',
            clickCount: 1,
          }),
        signal,
      )
      await withAbort(
        () =>
          this.contents.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: result.x,
            y: result.y,
            button: 'left',
            clickCount: 1,
          }),
        signal,
      )
      return result
    } catch (error) {
      throwIfAborted(signal)
      throw new BrowserError(
        t('The browser click could not be completed: {value0}', {
          value0: error instanceof Error ? error.message : String(error),
        }),
        'browser_operation_failed',
      )
    } finally {
      if (this.contents.debugger.isAttached()) {
        await this.contents.debugger
          .sendCommand('Page.setInterceptFileChooserDialog', { enabled: !this.fileChooserAllowed })
          .catch(() => undefined)
      }
    }
  }

  async typeText(
    snapshotId: string,
    ref: string,
    text: string,
    mode: 'replace' | 'append',
    signal?: AbortSignal,
  ): Promise<BrowserActionPayload> {
    const result = await withAbort(() => this.run({ action: 'type', snapshotId, ref, text, mode }), signal)
    if (!isActionPayload(result, 'typed')) {
      throw new BrowserError(t('The browser text input could not be completed.'), 'browser_operation_failed')
    }
    return result
  }

  async uploadFiles(
    snapshotId: string,
    ref: string,
    files: string[],
    signal?: AbortSignal,
  ): Promise<BrowserResolvedElement> {
    throwIfAborted(signal)
    const token = randomUUID().replaceAll('-', '')
    const result = await withAbort(() => this.run({ action: 'mark-upload', snapshotId, ref, token }), signal)
    if (!isResolvedElement(result) || result.inputType !== 'file' || result.uploadToken !== token) {
      throw new BrowserError(t('The browser element is not a file input.'), 'element_not_found')
    }
    try {
      throwIfAborted(signal)
      if (!this.contents.debugger.isAttached()) this.contents.debugger.attach('1.3')
      await withAbort(() => this.contents.debugger.sendCommand('DOM.enable'), signal)
      const documentResult = (await withAbort(
        () => this.contents.debugger.sendCommand('DOM.getDocument', { depth: 1 }),
        signal,
      )) as {
        root?: { nodeId?: number }
      }
      const rootNodeId = documentResult.root?.nodeId
      if (!rootNodeId) throw new Error('Missing DOM root')
      const queryResult = (await withAbort(
        () =>
          this.contents.debugger.sendCommand('DOM.querySelector', {
            nodeId: rootNodeId,
            selector: `[data-agentbox-upload-token="${token}"]`,
          }),
        signal,
      )) as { nodeId?: number }
      if (!queryResult.nodeId) throw new Error('File input disappeared')
      throwIfAborted(signal)
      await this.contents.debugger.sendCommand('DOM.setFileInputFiles', {
        nodeId: queryResult.nodeId,
        files,
      })
      throwIfAborted(signal)
      await this.contents.debugger
        .sendCommand('DOM.removeAttribute', {
          nodeId: queryResult.nodeId,
          name: 'data-agentbox-upload-token',
        })
        .catch(() => undefined)
      return result
    } catch {
      throwIfAborted(signal)
      throw new BrowserError(t('The browser upload could not be completed.'), 'browser_operation_failed')
    }
  }

  async scroll(
    direction: 'up' | 'down',
    amount: 'half-page' | 'page',
    signal?: AbortSignal,
  ): Promise<BrowserActionPayload> {
    const result = await withAbort(() => this.run({ action: 'scroll', direction, amount }), signal)
    if (!isActionPayload(result, 'scrolled')) {
      throw new BrowserError(t('The browser page could not be scrolled.'), 'browser_operation_failed')
    }
    return result
  }

  close(): void {
    if (this.contents.debugger.isAttached()) {
      try {
        this.contents.debugger.detach()
      } catch {}
    }
  }

  private async run(input: Parameters<typeof buildBrowserWorldScript>[0]): Promise<unknown> {
    if (this.contents.isDestroyed()) throw new BrowserError(t('The browser page is unavailable.'), 'browser_crashed')
    try {
      return (await this.contents.executeJavaScriptInIsolatedWorld(BROWSER_ISOLATED_WORLD_ID, [
        { code: buildBrowserWorldScript(input) },
      ])) as unknown
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('stale_snapshot')) {
        throw new BrowserError(t('The browser snapshot is stale. Capture a fresh snapshot.'), 'stale_snapshot')
      }
      if (message.includes('element_not_found') || message.includes('element_not_editable')) {
        throw new BrowserError(t('The browser element is no longer available.'), 'element_not_found')
      }
      if (message.includes('sensitive_input')) {
        throw new BrowserError(t('The Agent cannot operate sensitive browser fields.'), 'sensitive_input')
      }
      throw new BrowserError(
        t('The browser operation failed: {value0}', { value0: message }),
        'browser_operation_failed',
      )
    }
  }
}

function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal)
}

async function withAbort<T>(operation: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  throwIfAborted(signal)
  const promise = operation()
  if (!signal) return promise
  let interrupted = false
  let abortListener: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => {
      interrupted = true
      reject(abortError(signal))
    }
    signal.addEventListener('abort', abortListener, { once: true })
  })
  try {
    return await Promise.race([promise, aborted])
  } catch (error) {
    if (interrupted) await promise.catch(() => undefined)
    throw error
  } finally {
    if (abortListener) signal.removeEventListener('abort', abortListener)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSnapshotPayload(value: unknown): value is BrowserSnapshotPayload {
  return (
    isRecord(value) &&
    value.kind === 'snapshot' &&
    typeof value.url === 'string' &&
    typeof value.title === 'string' &&
    typeof value.text === 'string' &&
    Array.isArray(value.elements) &&
    isRecord(value.viewport)
  )
}

function isResolvedElement(value: unknown): value is BrowserResolvedElement {
  return (
    isRecord(value) &&
    value.kind === 'resolved' &&
    typeof value.ref === 'string' &&
    typeof value.x === 'number' &&
    typeof value.y === 'number' &&
    typeof value.sensitive === 'boolean'
  )
}

function isActionPayload(value: unknown, kind: BrowserActionPayload['kind']): value is BrowserActionPayload {
  return isRecord(value) && value.kind === kind && typeof value.url === 'string'
}
