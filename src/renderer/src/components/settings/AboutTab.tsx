import type { JSX } from 'react'
import { t } from '../../../../shared/i18n'
import { Icon } from '../Icon'

export function AboutTab(): JSX.Element {
  return (
    <div className="about-panel">
      <div className="about-mark"><Icon name="app" size={42} /></div>
      <h2>AgentBox</h2>
      <p>{t("私密、强大的多模型 AI 智能体与桌面客户端。")}</p>
      <span className="version-pill">{t('about.version', { version: '0.1.0' })}</span>
      <div className="about-divider" />
      <small>{t('about.builtWith')}</small>
    </div>
  )
}
