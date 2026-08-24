import { afterEach, describe, expect, it } from 'vitest'
import {
  languageFromSystemLocale,
  resourceBundle,
  setLanguage,
  t,
  type MessageKey,
} from '../src/shared/i18n'
import { DEFAULT_SKILLS, localizedDefaultSkills } from '../src/electron/storage/default-skills'

afterEach(() => setLanguage('zh-CN'))

describe('application localization', () => {
  it('uses Chinese for Chinese system locales and English for every other locale', () => {
    expect(languageFromSystemLocale('zh-CN')).toBe('zh-CN')
    expect(languageFromSystemLocale('zh-TW')).toBe('zh-CN')
    expect(languageFromSystemLocale('en-US')).toBe('en-US')
    expect(languageFromSystemLocale('ja-JP')).toBe('en-US')
    expect(languageFromSystemLocale(undefined)).toBe('en-US')
  })

  it('uses English source copy as the message key and keeps bundles structurally aligned', () => {
    const chinese = resourceBundle('zh-CN')
    const english = resourceBundle('en-US')
    const zhKeys = Object.keys(chinese)

    // English source copy is the key: keys carry no CJK.
    expect(zhKeys.every((key) => !/[㐀-鿿]/u.test(key))).toBe(true)
    // The English bundle holds only the small set of semantic hatch keys.
    expect(Object.keys(english).every((key) => !/[㐀-鿿]/u.test(key))).toBe(true)
    // Every English hatch key must also exist in the Chinese bundle.
    for (const key of Object.keys(english)) expect(chinese).toHaveProperty(key)

    // Placeholder sets must match between an English key and its Chinese value.
    for (const key of zhKeys) {
      const keyPlaceholders = (key.match(/\{[A-Za-z0-9_]+\}/g) ?? []).sort()
      expect((chinese[key]?.match(/\{[A-Za-z0-9_]+\}/g) ?? []).sort()).toEqual(keyPlaceholders)
    }
    for (const key of Object.keys(english)) {
      const keyPlaceholders = (key.match(/\{[A-Za-z0-9_]+\}/g) ?? []).sort()
      expect((english[key]?.match(/\{[A-Za-z0-9_]+\}/g) ?? []).sort()).toEqual(keyPlaceholders)
    }
  })

  it('uses canonical product terminology in English keys', () => {
    const chinese = resourceBundle('zh-CN')
    const keys = Object.keys(chinese)
    // English keys must never carry the disallowed machine-translation phrasings.
    const globallyForbidden = /\b(?:supplier|vendor|service provider|MCP service|prompt word|contextual cropping|current site|current scene|compressed package|clear text|thinking intensity|smart search|mount all|shortcode|legal JSON|cue word|tool intelligent)\b/i
    expect(keys.filter((key) => globallyForbidden.test(key))).toEqual([])

    expect(chinese['Close']).toBe('关闭')
    expect(chinese['Off']).toBe('关闭')
    expect(chinese['Default reasoning effort']).toBe('默认思考强度')
    expect(chinese['Anthropic thinking mode']).toBe('Anthropic 思考协议')
    expect(chinese['Provider']).toBe('服务商')
  })

  it('never places executable built-in skill assets in language bundles', () => {
    const chinese = resourceBundle('zh-CN')
    const english = resourceBundle('en-US')
    for (const skill of DEFAULT_SKILLS) {
      for (const file of skill.files) {
        if (file.kind === 'markdown') continue
        expect(chinese).not.toHaveProperty(file.content)
        expect(english).not.toHaveProperty(file.content)
      }
    }
  })

  it('keeps every localizable built-in skill field in the Chinese catalog', () => {
    const chinese = resourceBundle('zh-CN')
    for (const skill of DEFAULT_SKILLS) {
      expect(chinese).toHaveProperty(skill.name)
      expect(chinese).toHaveProperty(skill.description)
      if (skill.systemPrompt) expect(chinese).toHaveProperty(skill.systemPrompt)
      for (const file of skill.files) {
        if (file.kind === 'markdown') expect(chinese).toHaveProperty(file.content)
      }
    }
  })

  it('materializes professionally reviewed English built-in skills', () => {
    setLanguage('en-US')
    const skills = localizedDefaultSkills()
    expect(skills.map((skill) => skill.name)).toEqual([
      'Code Execution & Algorithm Assistant',
      'Data Analysis & Visualization',
      'Research & Document Analysis',
      'Professional Translation & Localization',
      'Prompt Engineering Expert',
    ])
    expect(skills[0]?.files.find((file) => file.path === 'SKILL.md')?.content).toContain('## Core Guidelines')
    expect(skills[4]?.files.find((file) => file.path === 'SKILL.md')?.content).toContain('## CRISP-E Prompt Framework')
  })

  it('switches bundles and interpolates dynamic values', () => {
    setLanguage('zh-CN')
    expect(t('Fetched {value0} models.', { value0: 3 })).toBe('已获取 3 个模型。')

    setLanguage('en-US')
    expect(t('Fetched {value0} models.', { value0: 3 })).toBe('Fetched 3 models.')
  })

  it('renders an English key as itself under English and resolves hatch keys', () => {
    setLanguage('en-US')
    // Plain English key: no en-US bundle entry, so the key renders as itself.
    expect(t('Close')).toBe('Close')
    // Semantic hatch key: en-US carries the shared English text.
    expect(t('language.displayName')).toBe('English')

    setLanguage('zh-CN')
    expect(t('Close')).toBe('关闭')
    expect(t('language.displayName')).toBe('简体中文')
  })

  it('degrades an untranslated key to its own English text', () => {
    setLanguage('zh-CN')
    // A key absent from the Chinese bundle renders as the English key itself.
    expect(t('Untranslated brand new copy' as MessageKey)).toBe('Untranslated brand new copy')
    setLanguage('en-US')
    expect(t('Untranslated brand new copy' as MessageKey)).toBe('Untranslated brand new copy')
  })
})
