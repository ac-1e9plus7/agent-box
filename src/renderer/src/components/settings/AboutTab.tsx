import type { JSX } from 'react'
import { t } from '../../../../shared/i18n'
import { Icon } from '../Icon'

export function AboutTab(): JSX.Element {
  return (
    <div className="about-panel">
      <div className="about-mark">
        <Icon name="app" size={42} />
      </div>
      <h2>AgentBox</h2>
      <p>{t('A private, powerful desktop client for multi-model AI agents.')}</p>
      <span className="version-pill">{t('Version {version}', { version: '0.1.0' })}</span>
      <div className="about-divider" />
      <small>{t('Built with React, Electron, and OpenRouter')}</small>
    </div>
  )
}
