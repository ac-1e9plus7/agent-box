import React from 'react'
import ReactDOM from 'react-dom/client'
import 'katex/dist/katex.min.css'
import './styles.css'
import { languageFromSystemLocale, setLanguage } from '../../shared/i18n'

async function renderApplication(): Promise<void> {
  // Load the persisted locale before importing UI modules. This also keeps
  // module-level resource lookups in sync on every application start.
  const initialLanguage = window.agentbox
    ? (await window.agentbox.settings.get()).language
    : languageFromSystemLocale(navigator.language)
  setLanguage(initialLanguage)
  document.documentElement.lang = initialLanguage
  const { default: App } = await import('./App')

  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

void renderApplication()
