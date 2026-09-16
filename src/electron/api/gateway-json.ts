import { GatewayError } from './gateway-error'
import { t } from '../../shared/i18n'

export function cloneJsonRecord(value: Record<string, unknown>, maxCharacters: number): Record<string, unknown> {
  const serialized = JSON.stringify(value)
  if (serialized.length > maxCharacters)
    throw new GatewayError(t('Agent structured data exceeds limit.'), 'invalid_request')
  return JSON.parse(serialized) as Record<string, unknown>
}
