import { enUS } from './locales/en-US'
import { zhCN } from './locales/zh-CN'

export const APP_LANGUAGES = ['zh-CN', 'en-US'] as const
export type AppLanguage = (typeof APP_LANGUAGES)[number]
export type MessageValues = Record<string, string | number | boolean | null | undefined>

/** Every accepted message key. English source copy is the key; tighten `t()` so
 *  typos, migration gaps, and references to removed keys surface at compile time. */
export type MessageKey = keyof typeof zhCN

const resources: Record<AppLanguage, Readonly<Record<string, string>>> = {
  'zh-CN': zhCN,
  'en-US': enUS,
}

// Tests and non-Electron utility consumers historically use the Chinese copy.
// Both application entry points explicitly set the persisted locale before
// user-facing work begins.
let activeLanguage: AppLanguage = 'zh-CN'

export function isAppLanguage(value: unknown): value is AppLanguage {
  return typeof value === 'string' && APP_LANGUAGES.includes(value as AppLanguage)
}

/** Chinese locales use Simplified Chinese; all other system locales use English. */
export function languageFromSystemLocale(locale: string | undefined): AppLanguage {
  return /^zh(?:-|_|$)/i.test(locale?.trim() ?? '') ? 'zh-CN' : 'en-US'
}

export function setLanguage(language: AppLanguage): void {
  activeLanguage = language
}

export function getLanguage(): AppLanguage {
  return activeLanguage
}

export function t(key: MessageKey, values?: MessageValues): string {
  // English source copy is the message key. en-US carries only the small set of
  // semantic "hatch" keys; any other key renders as itself under English.
  const template = resources[activeLanguage][key] ?? resources['en-US'][key] ?? key
  if (!values) return template
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? (values[name] == null ? '' : String(values[name])) : match,
  )
}

export function resourceBundle(language: AppLanguage): Readonly<Record<string, string>> {
  return resources[language]
}
