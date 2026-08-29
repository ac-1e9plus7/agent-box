import { useEffect, useRef, useState } from 'react'
import type { FormEvent, JSX } from 'react'
import type { BrowserCommand, BrowserState } from '../../../../shared/types'
import { t } from '../../../../shared/i18n'
import { Icon } from '../Icon'

interface BrowserPanelProps {
  conversationId: string
  state?: BrowserState
  viewVisible: boolean
  onClosePanel: () => void
  onState: (state: BrowserState) => void
  onError: (message: string) => void
}

export function BrowserPanel({
  conversationId,
  state,
  viewVisible,
  onClosePanel,
  onState,
  onError,
}: BrowserPanelProps): JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [address, setAddress] = useState(state?.url ?? '')
  const [editingAddress, setEditingAddress] = useState(false)

  useEffect(() => {
    if (!editingAddress) setAddress(state?.url ?? '')
  }, [editingAddress, state?.url])

  useEffect(() => {
    let disposed = false
    void window.agentbox.browser
      .ensure(conversationId)
      .then((next) => {
        if (!disposed) onState(next)
      })
      .catch((error) => onError(error instanceof Error ? error.message : String(error)))
    return () => {
      disposed = true
    }
  }, [conversationId, onError, onState])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    let frame: number | undefined
    const syncBounds = (): void => {
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        const rect = viewport.getBoundingClientRect()
        void window.agentbox.browser
          .setViewState({
            conversationId,
            visible: viewVisible && rect.width > 0 && rect.height > 0,
            bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          })
          .then(onState)
          .catch((error) => onError(error instanceof Error ? error.message : String(error)))
      })
    }
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(syncBounds)
    observer?.observe(viewport)
    window.addEventListener('resize', syncBounds)
    syncBounds()
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', syncBounds)
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      const rect = viewport.getBoundingClientRect()
      void window.agentbox.browser
        .setViewState({
          conversationId,
          visible: false,
          bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        })
        .catch(() => undefined)
    }
  }, [conversationId, onError, onState, viewVisible])

  const navigate = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const target = address.trim()
    if (!target) return
    try {
      const next = await window.agentbox.browser.navigate(
        conversationId,
        /^[a-z][a-z0-9+.-]*:/i.test(target) ? target : `https://${target}`,
        state?.activeTabId,
      )
      onState(next)
      setEditingAddress(false)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    }
  }

  const command = async (value: BrowserCommand): Promise<void> => {
    try {
      onState(await window.agentbox.browser.command(conversationId, value, state?.activeTabId))
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <aside className="browser-panel" aria-label={t('Built-in browser')}>
      <div className="browser-tabs" role="tablist" aria-label={t('Browser tabs')}>
        {state?.tabs.map((tab) => (
          <div className={`browser-tab ${tab.id === state.activeTabId ? 'is-active' : ''}`} key={tab.id}>
            <button
              aria-selected={tab.id === state.activeTabId}
              onClick={() => {
                void window.agentbox.browser
                  .switchTab(conversationId, tab.id)
                  .then(onState)
                  .catch((error) => {
                    onError(error instanceof Error ? error.message : String(error))
                  })
              }}
              role="tab"
              type="button"
            >
              <span>{tab.title || tab.url || t('New tab')}</span>
            </button>
            <button
              aria-label={t('Close browser tab')}
              onClick={() => {
                void window.agentbox.browser
                  .closeTab(conversationId, tab.id)
                  .then(onState)
                  .catch((error) => {
                    onError(error instanceof Error ? error.message : String(error))
                  })
              }}
              type="button"
            >
              <Icon name="close" size={11} />
            </button>
          </div>
        ))}
        <button
          aria-label={t('New browser tab')}
          className="browser-new-tab"
          onClick={() => {
            void window.agentbox.browser
              .newTab(conversationId)
              .then(onState)
              .catch((error) => {
                onError(error instanceof Error ? error.message : String(error))
              })
          }}
          type="button"
        >
          <Icon name="plus" size={14} />
        </button>
      </div>
      <div className="browser-toolbar">
        <button
          aria-label={t('Browser back')}
          className="icon-button"
          disabled={!state?.canGoBack}
          onClick={() => void command('back')}
          type="button"
        >
          <Icon name="chevron-left" size={16} />
        </button>
        <button
          aria-label={t('Browser forward')}
          className="icon-button"
          disabled={!state?.canGoForward}
          onClick={() => void command('forward')}
          type="button"
        >
          <Icon name="chevron-right" size={16} />
        </button>
        <button
          aria-label={state?.loading ? t('Stop browser loading') : t('Reload browser page')}
          className="icon-button"
          onClick={() => void command(state?.loading ? 'stop' : 'reload')}
          type="button"
        >
          <Icon name={state?.loading ? 'close' : 'refresh'} size={15} />
        </button>
        <form className="browser-address-form" onSubmit={(event) => void navigate(event)}>
          <Icon name="globe" size={14} />
          <input
            aria-label={t('Browser address')}
            onBlur={() => setEditingAddress(false)}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={() => setEditingAddress(true)}
            placeholder="https://example.com"
            spellCheck={false}
            value={address}
          />
        </form>
        <button
          aria-label={t('Close browser session')}
          className="icon-button"
          onClick={() => {
            void window.agentbox.browser.close(conversationId).catch(() => undefined)
            onClosePanel()
          }}
          type="button"
        >
          <Icon name="trash" size={15} />
        </button>
        <button aria-label={t('Hide browser panel')} className="icon-button" onClick={onClosePanel} type="button">
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="browser-status-line">
        <span>{state?.title || t('Temporary isolated browser session')}</span>
        {state?.error && <em>{state.error}</em>}
      </div>
      <div className="browser-viewport" ref={viewportRef} />
    </aside>
  )
}
