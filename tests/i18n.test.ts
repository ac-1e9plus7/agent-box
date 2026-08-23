import { afterEach, describe, expect, it } from 'vitest'
import {
  languageFromSystemLocale,
  resourceBundle,
  setLanguage,
  t,
} from '../src/shared/i18n'

afterEach(() => setLanguage('zh-CN'))

describe('application localization', () => {
  it('uses Chinese for Chinese system locales and English for every other locale', () => {
    expect(languageFromSystemLocale('zh-CN')).toBe('zh-CN')
    expect(languageFromSystemLocale('zh-TW')).toBe('zh-CN')
    expect(languageFromSystemLocale('en-US')).toBe('en-US')
    expect(languageFromSystemLocale('ja-JP')).toBe('en-US')
    expect(languageFromSystemLocale(undefined)).toBe('en-US')
  })

  it('keeps the Chinese and English resource packs structurally aligned', () => {
    const chinese = resourceBundle('zh-CN')
    const english = resourceBundle('en-US')
    expect(Object.keys(english).sort()).toEqual(Object.keys(chinese).sort())
    expect(Object.values(english).every((value) => !/[\u3400-\u9fff]/u.test(value))).toBe(true)

    for (const key of Object.keys(chinese)) {
      const placeholders = (chinese[key]?.match(/\{[A-Za-z0-9_]+\}/g) ?? []).sort()
      expect((english[key]?.match(/\{[A-Za-z0-9_]+\}/g) ?? []).sort()).toEqual(placeholders)
    }
  })

  it('switches bundles and interpolates dynamic values', () => {
    setLanguage('zh-CN')
    expect(t('已获取 {value0} 个模型。', { value0: 3 })).toBe('已获取 3 个模型。')

    setLanguage('en-US')
    expect(t('已获取 {value0} 个模型。', { value0: 3 })).toBe('Fetched 3 models.')
  })
})

