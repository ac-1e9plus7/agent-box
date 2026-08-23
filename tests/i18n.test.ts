import { afterEach, describe, expect, it } from 'vitest'
import {
  languageFromSystemLocale,
  resourceBundle,
  setLanguage,
  t,
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

  it('uses product terminology consistently in the English bundle', () => {
    const english = resourceBundle('en-US')
    const rules: Array<{ source: RegExp; forbidden: RegExp }> = [
      { source: /服务商|供应商/u, forbidden: /\b(?:supplier|vendor|service provider)s?\b/i },
      { source: /MCP 服务/u, forbidden: /\bMCP services?\b/i },
      { source: /会话/u, forbidden: /\bsessions?\b/i },
      { source: /提示词/u, forbidden: /\bprompt words?\b/i },
      { source: /明文/u, forbidden: /\b(?:clear text|plain text)\b/i },
      { source: /压缩包/u, forbidden: /\bcompressed packages?\b/i },
      { source: /现场/u, forbidden: /\b(?:site|scene)\b/i },
      { source: /联网搜索|网页搜索/u, forbidden: /\b(?:network|Internet|networking) searches?\b/i },
      { source: /思考强度/u, forbidden: /\bthinking intensity\b/i },
      { source: /上下文裁剪/u, forbidden: /\bcontextual cropping\b/i },
    ]
    for (const [key, value] of Object.entries(english)) {
      for (const rule of rules) {
        if (rule.source.test(key)) expect(value).not.toMatch(rule.forbidden)
      }
    }
    const globallyForbidden = /\b(?:supplier|vendor|service provider|MCP service|prompt word|contextual cropping|current site|current scene|compressed package|clear text|thinking intensity|smart search|mount all|shortcode|legal JSON|cue word|tool intelligent)\b/i
    expect(Object.values(english).filter((value) => globallyForbidden.test(value))).toEqual([])
    expect(english['Chat Completions 仍受支持，但 OpenAI 建议所有新项目使用 Responses。仅当兼容服务商尚未实现 /v1/responses 时选择此格式。']).toContain('Responses API')
    expect(english['默认思考强度']).toBe('Default reasoning effort')
    expect(english['Anthropic 思考协议']).toBe('Anthropic thinking mode')
    expect(english['common.close']).toBe('Close')
    expect(english['common.off']).toBe('Off')
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
    expect(t('已获取 {value0} 个模型。', { value0: 3 })).toBe('已获取 3 个模型。')

    setLanguage('en-US')
    expect(t('已获取 {value0} 个模型。', { value0: 3 })).toBe('Fetched 3 models.')
  })
})
