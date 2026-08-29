import { Buffer } from 'node:buffer'

export type BrowserWorldInput =
  | { action: 'snapshot'; snapshotId: string }
  | { action: 'resolve'; snapshotId: string; ref: string }
  | { action: 'type'; snapshotId: string; ref: string; text: string; mode: 'replace' | 'append' }
  | { action: 'mark-upload'; snapshotId: string; ref: string; token: string }
  | { action: 'scroll'; direction: 'up' | 'down'; amount: 'half-page' | 'page' }

export interface BrowserSnapshotElement {
  ref: string
  role: string
  name: string
  tag: string
  disabled?: boolean
  checked?: boolean
  href?: string
  inputType?: string
  autocomplete?: string
}

export interface BrowserSnapshotPayload {
  kind: 'snapshot'
  url: string
  title: string
  text: string
  elements: BrowserSnapshotElement[]
  viewport: { width: number; height: number; scrollX: number; scrollY: number }
}

export interface BrowserResolvedElement {
  kind: 'resolved'
  ref: string
  tag: string
  role: string
  name: string
  href?: string
  inputType?: string
  autocomplete?: string
  editable: boolean
  sensitive: boolean
  x: number
  y: number
  uploadToken?: string
}

export interface BrowserActionPayload {
  kind: 'typed' | 'scrolled'
  url: string
  scrollX?: number
  scrollY?: number
}

export function buildBrowserWorldScript(input: BrowserWorldInput): string {
  const encoded = Buffer.from(JSON.stringify(input), 'utf8').toString('base64')
  return `(${browserWorldRuntime.toString()})(${JSON.stringify(encoded)})`
}

function browserWorldRuntime(encodedPayload: string): unknown {
  const binary = atob(encodedPayload)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  const input = JSON.parse(new TextDecoder().decode(bytes)) as BrowserWorldInput
  const world = globalThis as typeof globalThis & {
    __agentboxBrowserWorld?: { snapshotId: string; refs: Map<string, Element> }
  }
  const state = world.__agentboxBrowserWorld ?? { snapshotId: '', refs: new Map<string, Element>() }
  world.__agentboxBrowserWorld = state

  const removeControls = (value: string): string =>
    Array.from(value)
      .filter((character) => {
        const code = character.charCodeAt(0)
        return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
      })
      .join('')

  const clean = (value: unknown, limit = 300): string =>
    removeControls(String(value ?? ''))
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, limit)

  const visible = (element: Element): boolean => {
    const html = element as HTMLElement
    const style = getComputedStyle(html)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
    const rect = html.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }

  const roleFor = (element: Element): string => {
    const explicit = clean(element.getAttribute('role'), 50)
    if (explicit) return explicit
    const tag = element.tagName.toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'button') return 'button'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'select') return 'combobox'
    if (tag === 'summary') return 'button'
    if (tag === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (['button', 'submit', 'reset'].includes(type)) return 'button'
      return 'textbox'
    }
    return element.getAttribute('contenteditable') === 'true' ? 'textbox' : tag
  }

  const nameFor = (element: Element): string => {
    const ariaLabel = clean(element.getAttribute('aria-label'))
    if (ariaLabel) return ariaLabel
    const labelledBy = element.getAttribute('aria-labelledby')
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || '')
        .join(' ')
      const named = clean(text)
      if (named) return named
    }
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
      const labels = Array.from(element.labels || [])
        .map((label) => label.textContent || '')
        .join(' ')
      const named = clean(labels || element.getAttribute('placeholder') || element.getAttribute('name'))
      if (named) return named
    }
    return clean(
      element.getAttribute('alt') ||
        element.getAttribute('title') ||
        (element as HTMLElement).innerText ||
        element.textContent,
    )
  }

  const describe = (ref: string, element: Element): BrowserSnapshotElement => {
    const inputElement = element instanceof HTMLInputElement ? element : undefined
    const checkable = inputElement && ['checkbox', 'radio'].includes(inputElement.type)
    const href = element instanceof HTMLAnchorElement ? element.href : undefined
    return {
      ref,
      role: roleFor(element),
      name: nameFor(element),
      tag: element.tagName.toLowerCase(),
      disabled:
        element instanceof HTMLButtonElement ||
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
          ? element.disabled || undefined
          : element.getAttribute('aria-disabled') === 'true' || undefined,
      checked: checkable ? inputElement.checked : undefined,
      href,
      inputType: inputElement?.type,
      autocomplete:
        element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
          ? element.autocomplete || undefined
          : undefined,
    }
  }

  const resolve = (snapshotId: string, ref: string): BrowserResolvedElement => {
    if (!snapshotId || state.snapshotId !== snapshotId) throw new Error('stale_snapshot')
    const element = state.refs.get(ref)
    if (!element || !element.isConnected || !visible(element)) throw new Error('element_not_found')
    const description = describe(ref, element)
    const rect = (element as HTMLElement).getBoundingClientRect()
    const inputType = description.inputType?.toLowerCase()
    const autocomplete = description.autocomplete?.toLowerCase()
    const sensitive =
      inputType === 'password' ||
      inputType === 'file' ||
      inputType === 'hidden' ||
      Boolean(autocomplete && /(?:password|one-time-code|^cc-)/.test(autocomplete))
    const editable =
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element.getAttribute('contenteditable') === 'true'
    return {
      kind: 'resolved',
      ref,
      tag: description.tag,
      role: description.role,
      name: description.name,
      href: description.href,
      inputType: description.inputType,
      autocomplete: description.autocomplete,
      editable,
      sensitive,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    }
  }

  if (input.action === 'snapshot') {
    const selector = [
      'a[href]',
      'button',
      'input:not([type="hidden"])',
      'textarea',
      'select',
      'summary',
      '[contenteditable="true"]',
      '[role="button"]',
      '[role="link"]',
      '[role="textbox"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',')
    const candidates: Element[] = []
    const root = document.body || document.documentElement
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
    let visited = 0
    let current: Node | null = walker.currentNode
    while (current && visited < 5_000 && candidates.length < 500) {
      if (current instanceof Element && current.matches(selector) && visible(current)) candidates.push(current)
      visited += 1
      current = walker.nextNode()
    }
    state.snapshotId = input.snapshotId
    state.refs = new Map<string, Element>()
    const elements = candidates.map((element, index) => {
      const ref = `e${index + 1}`
      state.refs.set(ref, element)
      return describe(ref, element)
    })
    return {
      kind: 'snapshot',
      url: location.href,
      title: clean(document.title, 500),
      text: String(document.body?.innerText || '').slice(0, 100_000),
      elements,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      },
    } satisfies BrowserSnapshotPayload
  }

  if (input.action === 'resolve') return resolve(input.snapshotId, input.ref)

  if (input.action === 'mark-upload') {
    const resolved = resolve(input.snapshotId, input.ref)
    if (resolved.inputType !== 'file') throw new Error('element_not_file_input')
    const element = state.refs.get(input.ref)
    if (!element) throw new Error('element_not_found')
    element.setAttribute('data-agentbox-upload-token', input.token)
    return { ...resolved, uploadToken: input.token } satisfies BrowserResolvedElement
  }

  if (input.action === 'type') {
    const resolved = resolve(input.snapshotId, input.ref)
    if (!resolved.editable) throw new Error('element_not_editable')
    if (resolved.sensitive) throw new Error('sensitive_input')
    const element = state.refs.get(input.ref)
    if (!element) throw new Error('element_not_found')
    element.scrollIntoView({ block: 'center', inline: 'nearest' })
    ;(element as HTMLElement).focus()
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const current = element.value
      const next = input.mode === 'append' ? `${current}${input.text}` : input.text
      element.value = next
    } else {
      const current = element.textContent || ''
      element.textContent = input.mode === 'append' ? `${current}${input.text}` : input.text
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: input.text }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    state.snapshotId = ''
    state.refs.clear()
    return { kind: 'typed', url: location.href } satisfies BrowserActionPayload
  }

  const distance = window.innerHeight * (input.amount === 'half-page' ? 0.5 : 0.9)
  window.scrollBy({ top: input.direction === 'down' ? distance : -distance, behavior: 'auto' })
  state.snapshotId = ''
  state.refs.clear()
  return {
    kind: 'scrolled',
    url: location.href,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  } satisfies BrowserActionPayload
}
