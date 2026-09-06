import type { JSX } from 'react'
import type { DataPlatConfig } from '../../../../shared/types'
import { t } from '../../../../shared/i18n'

export function DataPlatFields({
  value,
  onChange,
}: {
  value?: DataPlatConfig | null
  onChange: (value: DataPlatConfig | null) => void
}): JSX.Element {
  return (
    <div className="skill-form-field">
      <label>
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) =>
            onChange(
              event.target.checked
                ? { apiBaseUrl: 'http://localhost:8080', agentId: 'agentbox', loginToken: '' }
                : null,
            )
          }
        />
        {t('Use data-plat governed authentication')}
      </label>
      {value && (
        <>
          <p>
            {t(
              'Use a data-plat login token. The main process obtains short-lived MCP credentials and confirms each execution. Tokens stay in the encrypted Vault.',
            )}
          </p>
          <label className="skill-form-field">
            <span>{t('Data platform API base URL')}</span>
            <input
              value={value.apiBaseUrl}
              onChange={(event) => onChange({ ...value, apiBaseUrl: event.target.value })}
            />
          </label>
          <label className="skill-form-field">
            <span>{t('Data platform Agent ID')}</span>
            <input value={value.agentId} onChange={(event) => onChange({ ...value, agentId: event.target.value })} />
          </label>
          <label className="skill-form-field">
            <span>{t('Data platform login token')}</span>
            <input
              type="password"
              autoComplete="off"
              value={value.loginToken}
              onChange={(event) => onChange({ ...value, loginToken: event.target.value })}
            />
          </label>
        </>
      )}
    </div>
  )
}
