export class BrowserError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'browser_disabled'
      | 'browser_unavailable'
      | 'invalid_url'
      | 'blocked_url'
      | 'navigation_failed'
      | 'navigation_timeout'
      | 'page_not_ready'
      | 'snapshot_not_found'
      | 'stale_snapshot'
      | 'element_not_found'
      | 'sensitive_input'
      | 'browser_crashed'
      | 'browser_operation_failed',
  ) {
    super(message)
    this.name = 'BrowserError'
  }
}
