import type {
  BrowserApprovalScope,
  McpToolResultContent,
  McpToolApprovalPolicy,
  McpToolDefinition,
  ToolApprovalDecision,
  ToolApprovalKind,
} from '../../shared/types'
import {
  BROWSER_CLICK_TOOL_NAME,
  BROWSER_CLOSE_TOOL_NAME,
  BROWSER_DOWNLOAD_TOOL_NAME,
  BROWSER_NAVIGATE_TOOL_NAME,
  BROWSER_SCREENSHOT_TOOL_NAME,
  BROWSER_SCROLL_TOOL_NAME,
  BROWSER_SERVER_ID,
  BROWSER_SNAPSHOT_TOOL_NAME,
  BROWSER_TABS_TOOL_NAME,
  BROWSER_TYPE_TOOL_NAME,
  BROWSER_UPLOAD_TOOL_NAME,
} from '../../shared/builtin-agent-tools'
import type { BrowserManager } from './browser-manager'
import { browserOrigin, normalizeBrowserUrl, redactBrowserUrl } from './browser-policy'
import { t } from '../../shared/i18n'

export interface BrowserToolApproval {
  required: boolean
  riskLevel: 'low' | 'sensitive'
  reason: string
  approvalKind?: ToolApprovalKind
  approvalScope?: BrowserApprovalScope
}

export interface BrowserToolExecutionResult {
  result: string
  structuredResult?: Record<string, unknown>
  resultTruncated?: boolean
  resultContent?: McpToolResultContent[]
}

export class BrowserToolExecutor {
  constructor(private readonly manager: BrowserManager) {}

  canHandle(tool: McpToolDefinition): boolean {
    return tool.serverId === BROWSER_SERVER_ID
  }

  approvalFor(
    policy: McpToolApprovalPolicy,
    conversationId: string,
    tool: McpToolDefinition,
    args: Record<string, unknown>,
    allowHttpLoopback: boolean,
  ): BrowserToolApproval {
    const tabAction = typeof args.action === 'string' ? args.action : 'list'
    const tabCreatesUrl = tool.name === BROWSER_TABS_TOOL_NAME && tabAction === 'new' && typeof args.url === 'string'
    if (policy === 'full-access') {
      return {
        required: false,
        riskLevel:
          tool.name === BROWSER_SCROLL_TOOL_NAME ||
          tool.name === BROWSER_CLOSE_TOOL_NAME ||
          (tool.name === BROWSER_TABS_TOOL_NAME && !tabCreatesUrl)
            ? 'low'
            : 'sensitive',
        reason: t('Full Access allows this browser operation; hard browser security restrictions still apply.'),
      }
    }

    const always = policy === 'always'
    if (tool.name === BROWSER_CLOSE_TOOL_NAME || (tool.name === BROWSER_TABS_TOOL_NAME && !tabCreatesUrl)) {
      const lowRiskTabAction = tool.name === BROWSER_CLOSE_TOOL_NAME || ['list', 'switch', 'close'].includes(tabAction)
      return {
        required: always || !lowRiskTabAction,
        riskLevel: lowRiskTabAction ? 'low' : 'sensitive',
        reason:
          tool.name === BROWSER_CLOSE_TOOL_NAME
            ? t('Close the ephemeral browser session and discard its in-memory site data.')
            : t('Manage the current conversation’s browser tabs.'),
        approvalKind: 'generic',
      }
    }

    let origin: string | undefined
    if (
      (tool.name === BROWSER_NAVIGATE_TOOL_NAME || tool.name === BROWSER_TABS_TOOL_NAME) &&
      typeof args.url === 'string'
    ) {
      try {
        origin = normalizeBrowserUrl(args.url, { allowHttpLoopback }).origin
      } catch {
        // Execution returns the precise policy error without asking for approval first.
        return {
          required: false,
          riskLevel: 'sensitive',
          reason: t('The requested browser URL does not pass the browser security policy.'),
        }
      }
    } else {
      origin = this.manager.currentOrigin(conversationId, typeof args.tab_id === 'string' ? args.tab_id : undefined)
    }

    const originApproved = Boolean(origin && this.manager.hasApprovedReadOrigin(conversationId, origin))
    const scope: BrowserApprovalScope | undefined = origin
      ? { kind: 'browser-origin', origin, capabilities: ['read'] }
      : undefined

    if (tool.name === BROWSER_NAVIGATE_TOOL_NAME) {
      return {
        required: always || !originApproved,
        riskLevel: 'sensitive',
        reason: t('Opening this URL sends a network request to {value0}.', { value0: origin || t('(unknown origin)') }),
        approvalKind: 'browser-navigation',
        approvalScope: scope,
      }
    }
    if (tool.name === BROWSER_SNAPSHOT_TOOL_NAME || tool.name === BROWSER_SCREENSHOT_TOOL_NAME) {
      return {
        required: always || Boolean(origin && !originApproved),
        riskLevel: 'sensitive',
        reason:
          tool.name === BROWSER_SCREENSHOT_TOOL_NAME
            ? t('Capturing this tab sends a screenshot to the configured model provider.')
            : t('Reading this page sends its visible text and controls to the configured model provider.'),
        approvalKind: 'browser-share',
        approvalScope: scope,
      }
    }
    if (tool.name === BROWSER_SCROLL_TOOL_NAME) {
      return {
        required: always || Boolean(origin && !originApproved),
        riskLevel: originApproved ? 'low' : 'sensitive',
        reason: t('Scrolling may cause the untrusted page to load additional remote content.'),
        approvalKind: 'browser-interaction',
        approvalScope: scope,
      }
    }
    return {
      required: true,
      riskLevel: 'sensitive',
      reason:
        tool.name === BROWSER_UPLOAD_TOOL_NAME
          ? t('Uploading files discloses workspace content to the current website.')
          : tool.name === BROWSER_DOWNLOAD_TOOL_NAME
            ? t('Downloading creates a new file in the conversation working directory.')
            : tool.name === BROWSER_TYPE_TOOL_NAME
              ? t('Typing text may disclose it to the current website or change remote state.')
              : t('Clicking a web page element may navigate, submit data, or cause remote side effects.'),
      approvalKind: 'browser-interaction',
    }
  }

  applyDecision(conversationId: string, approval: BrowserToolApproval, decision: ToolApprovalDecision): void {
    if (decision.decision !== 'allow-browser-origin') return
    const scope = approval.approvalScope
    if (scope?.kind === 'browser-origin') this.manager.grantReadOrigin(conversationId, scope.origin)
  }

  sanitizeArguments(tool: McpToolDefinition, args: Record<string, unknown>): Record<string, unknown> {
    if (
      (tool.name === BROWSER_NAVIGATE_TOOL_NAME || tool.name === BROWSER_TABS_TOOL_NAME) &&
      typeof args.url === 'string'
    ) {
      return { ...args, url: redactBrowserUrl(args.url) }
    }
    return structuredClone(args)
  }

  async execute(
    conversationId: string,
    tool: McpToolDefinition,
    args: Record<string, unknown>,
    signal: AbortSignal,
    workingDirectory?: string,
  ): Promise<BrowserToolExecutionResult> {
    const tabId = typeof args.tab_id === 'string' ? args.tab_id : undefined
    if (tool.name === BROWSER_TABS_TOOL_NAME) {
      const action = String(args.action || 'list')
      let state
      if (action === 'new') {
        state = await this.manager.newTab(conversationId, typeof args.url === 'string' ? args.url : undefined)
      } else if (action === 'switch') {
        state = await this.manager.switchTab(conversationId, String(args.tab_id || ''))
      } else if (action === 'close') {
        state = await this.manager.closeTab(conversationId, String(args.tab_id || ''))
      } else {
        state = this.manager.listTabs(conversationId) ?? (await this.manager.ensure(conversationId))
      }
      const result = {
        action,
        active_tab_id: state.activeTabId,
        tabs: state.tabs.map((tab) => ({ tab_id: tab.id, title: tab.title, url: tab.url, loading: tab.loading })),
      }
      return { result: JSON.stringify(result), structuredResult: result }
    }
    if (tool.name === BROWSER_NAVIGATE_TOOL_NAME) {
      const timeoutSeconds = typeof args.timeout_seconds === 'number' ? args.timeout_seconds : undefined
      const state = await this.manager.navigate(conversationId, String(args.url || ''), {
        signal,
        tabId,
        timeoutMs: timeoutSeconds ? timeoutSeconds * 1_000 : undefined,
      })
      const targetTabId = tabId || state.activeTabId
      const targetTab = state.tabs.find((tab) => tab.id === targetTabId)
      const result = {
        action: 'navigate',
        tab_id: targetTabId,
        url: targetTab?.url || '',
        title: targetTab?.title || '',
        phase: state.phase,
        fresh_snapshot_required: true,
      }
      return { result: JSON.stringify(result), structuredResult: result }
    }
    if (tool.name === BROWSER_SNAPSHOT_TOOL_NAME) {
      const result = await this.manager.snapshot(conversationId, {
        tabId,
        snapshotId: typeof args.snapshot_id === 'string' ? args.snapshot_id : undefined,
        offset: typeof args.offset === 'number' ? args.offset : undefined,
        maxCharacters: typeof args.max_characters === 'number' ? args.max_characters : undefined,
      })
      return {
        result: result.result,
        structuredResult: result.structuredResult,
        resultTruncated: result.truncated,
      }
    }
    if (tool.name === BROWSER_CLICK_TOOL_NAME) {
      return this.manager.click(conversationId, tabId, String(args.snapshot_id || ''), String(args.ref || ''))
    }
    if (tool.name === BROWSER_TYPE_TOOL_NAME) {
      return this.manager.typeText(
        conversationId,
        tabId,
        String(args.snapshot_id || ''),
        String(args.ref || ''),
        String(args.text ?? ''),
        args.mode === 'append' ? 'append' : 'replace',
      )
    }
    if (tool.name === BROWSER_SCROLL_TOOL_NAME) {
      return this.manager.scroll(
        conversationId,
        tabId,
        args.direction === 'up' ? 'up' : 'down',
        args.amount === 'half-page' ? 'half-page' : 'page',
      )
    }
    if (tool.name === BROWSER_SCREENSHOT_TOOL_NAME) {
      const result = await this.manager.screenshot(
        conversationId,
        tabId,
        typeof args.max_dimension === 'number' ? args.max_dimension : undefined,
      )
      return {
        result: result.result,
        structuredResult: result.structuredResult,
        resultContent: result.resultContent,
      }
    }
    if (tool.name === BROWSER_UPLOAD_TOOL_NAME) {
      const paths = Array.isArray(args.paths)
        ? args.paths.filter((path): path is string => typeof path === 'string')
        : []
      return this.manager.upload(
        conversationId,
        workingDirectory,
        tabId,
        String(args.snapshot_id || ''),
        String(args.ref || ''),
        paths,
      )
    }
    if (tool.name === BROWSER_DOWNLOAD_TOOL_NAME) {
      return this.manager.download(
        conversationId,
        workingDirectory,
        tabId,
        String(args.snapshot_id || ''),
        String(args.ref || ''),
        typeof args.path === 'string' ? args.path : undefined,
      )
    }
    if (tool.name === BROWSER_CLOSE_TOOL_NAME) {
      await this.manager.close(conversationId)
      return {
        result: JSON.stringify({ action: 'close', closed: true }),
        structuredResult: { action: 'close', closed: true },
      }
    }
    throw new Error(t('Unknown built-in browser tool.'))
  }

  currentOrigin(conversationId: string): string | undefined {
    const state = this.manager.getState(conversationId)
    return state ? browserOrigin(state.url) : undefined
  }
}
