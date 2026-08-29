import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { DEFAULT_SKILLS } from '../src/electron/storage/default-skills'
import { setLanguage } from '../src/shared/i18n'
import { exportSkillToZip, parseSkillFromZip, inferFileKind, parseSkillFrontmatter } from '../src/shared/skill-zip'
import type { Skill } from '../src/shared/types'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8'),
  },
}))

const { AppRepository } = await import('../src/electron/storage/app-repository')
const { buildAgentSystemPrompt, validateChatRequest } = await import('../src/electron/api/gateway')
const { retrieveRelevantSkills } = await import('../src/electron/api/skill-retriever')
const { normalizeAppSettings } = await import('../src/electron/storage/settings-schema')

describe('Skills Management and Agent Mode (Multi-file & Zip)', () => {
  let tempDirectory: string
  let repository: InstanceType<typeof AppRepository>

  beforeAll(async () => {
    tempDirectory = mkdtempSync(join(tmpdir(), 'agentbox-skills-test-'))
    repository = new AppRepository(tempDirectory)
    await repository.initialize()
  })

  afterAll(() => {
    repository.destroy()
    rmSync(tempDirectory, { recursive: true, force: true })
  })

  describe('Default Skills Multi-File & Python Script Definitions', () => {
    it('provides 5 built-in preset skills', () => {
      expect(DEFAULT_SKILLS).toHaveLength(5)
      const ids = DEFAULT_SKILLS.map((s) => s.id)
      expect(ids).toContain('code-interpreter')
      expect(ids).toContain('web-extractor')
      expect(ids).toContain('data-analyst')
      expect(ids).toContain('translator-polyglot')
      expect(ids).toContain('prompt-optimizer')
    })

    it('each built-in skill contains multiple markdown files and Python 3 scripts', () => {
      for (const skill of DEFAULT_SKILLS) {
        expect(skill.isBuiltIn).toBe(true)
        expect(skill.enabled).toBe(true)
        expect(skill.name).toBeTruthy()
        expect(skill.description).toBeTruthy()
        expect(skill.entryFile).toBe('SKILL.md')
        expect(skill.files.length).toBeGreaterThanOrEqual(2)

        const mdFiles = skill.files.filter((f) => f.kind === 'markdown')
        expect(mdFiles.length).toBeGreaterThanOrEqual(2)
        expect(mdFiles.some((f) => f.path === 'SKILL.md')).toBe(true)

        const pyScripts = skill.files.filter((f) => f.kind === 'python')
        expect(pyScripts.length).toBeGreaterThanOrEqual(1)
        for (const py of pyScripts) {
          expect(py.path.endsWith('.py')).toBe(true)
          expect(py.content).toContain('python3')
        }
      }
    })
  })

  describe('Zip Packaging, Exporting and Parsing', () => {
    it('infers file kinds accurately', () => {
      expect(inferFileKind('SKILL.md')).toBe('markdown')
      expect(inferFileKind('references/guide.markdown')).toBe('markdown')
      expect(inferFileKind('scripts/sandbox.py')).toBe('python')
      expect(inferFileKind('scripts/runner.sh')).toBe('shell')
      expect(inferFileKind('config.json')).toBe('other')
    })

    it('parses YAML frontmatter from markdown headers', () => {
      const markdownWithFrontmatter = `---
name: "测试技能"
description: '测试技能描述'
version: "2.1.0"
author: "Antigravity"
icon: "code"
---

# 测试技能详细指令
这是正文内容。`
      const { metadata, body } = parseSkillFrontmatter(markdownWithFrontmatter)
      expect(metadata.name).toBe('测试技能')
      expect(metadata.description).toBe('测试技能描述')
      expect(metadata.version).toBe('2.1.0')
      expect(metadata.author).toBe('Antigravity')
      expect(metadata.icon).toBe('code')
      expect(body).toContain('# 测试技能详细指令')
    })

    it('exports a multi-file skill to a Zip buffer and parses it back accurately', async () => {
      const originalSkill: Skill = {
        id: 'math-solver',
        name: '数学推演专家',
        description: '高难度数学与符号推导助手',
        icon: 'tool',
        entryFile: 'SKILL.md',
        files: [
          {
            path: 'SKILL.md',
            kind: 'markdown',
            content: '# 数学推演专家\n\n请按步骤严谨推演公式。',
          },
          {
            path: 'scripts/solver.py',
            kind: 'python',
            content: '#!/usr/bin/env python3\ndef solve():\n    return 42\n',
          },
          {
            path: 'references/formulas.md',
            kind: 'markdown',
            content: '# 常见公式参考\n\n- 欧拉公式: e^(i*pi) + 1 = 0',
          },
        ],
        isBuiltIn: false,
        enabled: true,
        author: 'Expert Team',
        version: '1.2.0',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      // Export to Zip
      const zipBytes = await exportSkillToZip(originalSkill)
      expect(zipBytes).toBeInstanceOf(Uint8Array)
      expect(zipBytes.length).toBeGreaterThan(50)

      // Parse from Zip
      const parsed = await parseSkillFromZip(zipBytes)
      expect(parsed.name).toBe('数学推演专家')
      expect(parsed.description).toBe('高难度数学与符号推导助手')
      expect(parsed.author).toBe('Expert Team')
      expect(parsed.version).toBe('1.2.0')
      expect(parsed.entryFile).toBe('SKILL.md')
      expect(parsed.files).toHaveLength(3)

      const solverScript = parsed.files?.find((f) => f.path === 'scripts/solver.py')
      expect(solverScript).toBeDefined()
      expect(solverScript?.kind).toBe('python')
      expect(solverScript?.content).toContain('def solve():')

      const formulasDoc = parsed.files?.find((f) => f.path === 'references/formulas.md')
      expect(formulasDoc).toBeDefined()
      expect(formulasDoc?.kind).toBe('markdown')
      expect(formulasDoc?.content).toContain('欧拉公式')
    })

    it('preserves a custom Markdown entry file through ZIP round trips', async () => {
      const parsed = await parseSkillFromZip(
        await exportSkillToZip({
          id: 'custom-entry',
          name: 'Custom entry',
          description: 'Keeps its selected entry document.',
          entryFile: 'instructions/START.md',
          files: [
            { path: 'README.md', kind: 'markdown', content: '# Read me\n\nNot the entry.' },
            { path: 'instructions/START.md', kind: 'markdown', content: '# Start\n\nUse this document.' },
          ],
          enabled: true,
        }),
      )

      expect(parsed.entryFile).toBe('instructions/START.md')
      expect(parsed.files?.map((file) => file.path)).toEqual(['README.md', 'instructions/START.md'])
    })

    it('caps scanned ZIP entries before ignored metadata can exhaust parsing work', async () => {
      const entries = Object.fromEntries(
        Array.from({ length: 129 }, (_, index) => [`__MACOSX/${index}.txt`, strToU8('metadata')]),
      )
      await expect(parseSkillFromZip(zipSync(entries))).rejects.toThrow()
    })

    it('stops ZIP entry enumeration at the archive file limit', async () => {
      const entries = Object.fromEntries(
        Array.from({ length: 52 }, (_, index) => [`references/${index}.md`, strToU8(`# ${index}`)]),
      )
      await expect(parseSkillFromZip(zipSync(entries))).rejects.toThrow()
    })

    it('rejects more than 50 actual Skill resources even without an import manifest', async () => {
      const entries = Object.fromEntries(
        Array.from({ length: 51 }, (_, index) => [`references/${index}.md`, strToU8(`# ${index}`)]),
      )
      await expect(parseSkillFromZip(zipSync(entries))).rejects.toThrow()
    })

    it('preserves a user resource that collides with the generated manifest base name', async () => {
      const parsed = await parseSkillFromZip(
        await exportSkillToZip({
          id: 'manifest-resource',
          name: 'Manifest resource',
          description: 'Preserves a similarly named resource.',
          entryFile: 'SKILL.md',
          files: [
            { path: 'SKILL.md', kind: 'markdown', content: '# Entry' },
            {
              path: 'agentbox-skill-manifest.json',
              kind: 'other',
              content: '{"userResource":true}',
            },
          ],
          enabled: true,
        }),
      )

      expect(parsed.files).toContainEqual({
        path: 'agentbox-skill-manifest.json',
        kind: 'other',
        content: '{"userResource":true}',
      })
    })

    it('rejects ZIP archives without a Markdown entry document', async () => {
      const archive = zipSync({ 'scripts/run.py': strToU8('print("hello")') })
      await expect(parseSkillFromZip(archive)).rejects.toThrow()
    })

    it('rejects ZIP text resources above the persisted character limit', async () => {
      const archive = zipSync({ 'SKILL.md': strToU8(`# Too long\n\n${'x'.repeat(500_000)}`) })
      await expect(parseSkillFromZip(archive)).rejects.toThrow()
    })

    it('rejects ZIP entries whose uncompressed content exceeds the import limit', async () => {
      const archive = zipSync({
        'SKILL.md': strToU8(`# Oversized\n\n${'x'.repeat(2 * 1024 * 1024)}`),
      })
      await expect(parseSkillFromZip(archive)).rejects.toThrow()
    })
  })

  describe('AppRepository Skills Operations with Multi-file Support', () => {
    it('lists default skills when vault is newly initialized', () => {
      const skills = repository.listSkills()
      expect(skills.length).toBeGreaterThanOrEqual(5)
      const codeInterpreter = skills.find((s) => s.id === 'code-interpreter')
      expect(codeInterpreter).toBeDefined()
      expect(codeInterpreter?.files.length).toBeGreaterThanOrEqual(2)
    })

    it('toggles a skill enabled state', async () => {
      const skillId = 'code-interpreter'
      const updated = await repository.toggleSkill(skillId, false)
      expect(updated.enabled).toBe(false)
      expect(repository.getSkill(skillId)?.enabled).toBe(false)

      const reEnabled = await repository.toggleSkill(skillId, true)
      expect(reEnabled.enabled).toBe(true)
      expect(repository.getSkill(skillId)?.enabled).toBe(true)
    })

    it('upserts a new custom multi-file skill', async () => {
      const custom = await repository.upsertSkill({
        name: '物理模拟专家',
        description: '力学与电磁学仿真推演',
        icon: 'zap',
        entryFile: 'SKILL.md',
        files: [
          {
            path: 'SKILL.md',
            kind: 'markdown',
            content: '# 物理模拟规范\n\n执行微分方程数值求解。',
          },
          {
            path: 'scripts/simulate.py',
            kind: 'python',
            content: '#!/usr/bin/env python3\nimport math\nprint("Simulating...")\n',
          },
        ],
        author: 'Physics Lab',
        version: '1.0.0',
      })

      expect(custom.id).toBeTruthy()
      expect(custom.isBuiltIn).toBe(false)
      expect(custom.name).toBe('物理模拟专家')
      expect(custom.enabled).toBe(true)
      expect(custom.files).toHaveLength(2)

      const fetched = repository.getSkill(custom.id)
      expect(fetched).toBeDefined()
      expect(fetched?.name).toBe('物理模拟专家')
      expect(fetched?.files.find((f) => f.path === 'scripts/simulate.py')).toBeDefined()
    })

    it('rejects a new Skill whose entry is not an included Markdown file', async () => {
      await expect(
        repository.upsertSkill({
          name: 'Invalid entry Skill',
          description: 'The entry must be Markdown.',
          entryFile: 'payload.txt',
          files: [{ path: 'payload.txt', kind: 'other', content: 'not instructions' }],
        }),
      ).rejects.toThrow()
    })

    it('rejects unsafe paths when saving a new Skill', async () => {
      await expect(
        repository.upsertSkill({
          name: 'Unsafe path Skill',
          description: 'Paths must stay package-relative.',
          entryFile: 'C:\\outside.md',
          files: [{ path: 'C:\\outside.md', kind: 'markdown', content: '# Unsafe' }],
        }),
      ).rejects.toThrow()
    })

    it('prevents deleting built-in skills', async () => {
      await expect(repository.removeSkill('code-interpreter')).rejects.toThrow('系统预置技能不可删除')
    })

    it('allows deleting custom skills', async () => {
      const custom = await repository.upsertSkill({
        name: '临时待删除技能',
        description: '测试删除',
        systemPrompt: '临时提示词',
      })

      expect(repository.getSkill(custom.id)).toBeDefined()
      await repository.removeSkill(custom.id)
      expect(repository.getSkill(custom.id)).toBeUndefined()
    })

    it('resets built-in skills while preserving custom skills', async () => {
      const custom = await repository.upsertSkill({
        name: '保留的自定义技能',
        description: '测试重置',
        systemPrompt: '测试保留',
      })

      // disable a builtin skill
      await repository.toggleSkill('translator-polyglot', false)
      expect(repository.getSkill('translator-polyglot')?.enabled).toBe(false)

      // reset defaults
      const reset = await repository.resetDefaultSkills()
      expect(reset.find((s) => s.id === 'translator-polyglot')?.enabled).toBe(true)
      expect(reset.find((s) => s.id === custom.id)).toBeDefined()
    })
  })

  describe('Agent System Prompt Assembly with Python 3 Scripts', () => {
    it('assembles active multi-file skills with Python 3 scripts into agent system prompt', () => {
      const activeSkills: Skill[] = [
        {
          id: 'code-helper',
          name: '代码助手',
          description: '编写与测试代码',
          icon: 'code',
          entryFile: 'SKILL.md',
          files: [
            {
              path: 'SKILL.md',
              kind: 'markdown',
              content: '生成健壮高质量的 TypeScript 和 Python 代码。',
            },
            {
              path: 'scripts/verify.py',
              kind: 'python',
              content: 'def verify(x):\n    assert x > 0',
            },
            {
              path: 'references/standards.md',
              kind: 'markdown',
              content: '代码命名与分支覆盖率规范。',
            },
          ],
          isBuiltIn: false,
          enabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]
      const prompt = buildAgentSystemPrompt(activeSkills, '全局系统指令')
      expect(prompt).toContain('【Agent 智能体模式已启用】')
      expect(prompt).toContain('Python 3 参考脚本（未自动执行）')
      expect(prompt).toContain('不得声称已经执行脚本')
      expect(prompt).toContain('[技能 1: 代码助手]')
      expect(prompt).toContain('生成健壮高质量的 TypeScript 和 Python 代码。')
      expect(prompt).toContain('## 附带 Python 3 参考脚本（未自动执行）:')
      expect(prompt).toContain('scripts/verify.py')
      expect(prompt).toContain('def verify(x):')
      expect(prompt).toContain('## 附带参考文档:')
      expect(prompt).toContain('references/standards.md')
      expect(prompt).toContain('=== 用户全局系统指令 ===')
      expect(prompt).toContain('全局系统指令')
    })

    it('does not inject an other file selected as a Skill entry', () => {
      const prompt = buildAgentSystemPrompt(
        [
          {
            id: 'invalid-entry',
            name: 'Invalid entry',
            description: 'A malformed legacy Skill.',
            entryFile: 'payload.txt',
            files: [
              { path: 'payload.txt', kind: 'other', content: 'INJECTED_OTHER_FILE_CONTENT' },
              { path: 'reference.md', kind: 'markdown', content: 'Reference content' },
            ],
            enabled: true,
          },
        ],
        '',
      )

      expect(prompt).not.toContain('INJECTED_OTHER_FILE_CONTENT')
      expect(prompt).not.toContain('[Skill 1: Invalid entry]')
    })

    it('does not use other assets for fuzzy Skill retrieval', () => {
      const skills: Skill[] = [
        {
          id: 'other-asset',
          name: 'General Skill',
          description: 'General guidance.',
          entryFile: 'SKILL.md',
          files: [
            { path: 'SKILL.md', kind: 'markdown', content: 'General instructions.' },
            { path: 'payload.bin', kind: 'other', content: 'secret-retrieval-token' },
          ],
          enabled: true,
        },
      ]

      expect(retrieveRelevantSkills('secret-retrieval-token', skills)).toEqual([])
    })

    it('rebuilds localized generic retrieval terms after switching to English', () => {
      setLanguage('en-US')
      try {
        const skills: Skill[] = [
          {
            id: 'analysis-skill',
            name: 'Analyze guide',
            description: 'Reference material.',
            entryFile: 'SKILL.md',
            files: [{ path: 'SKILL.md', kind: 'markdown', content: 'Analyze information carefully.' }],
            enabled: true,
          },
        ]

        expect(retrieveRelevantSkills('analyze', skills)).toEqual([])
      } finally {
        setLanguage('zh-CN')
      }
    })

    it('omits disabled skills from the assembled prompt', () => {
      const skills: Skill[] = [
        {
          id: 's1',
          name: '已禁用技能',
          description: '描述',
          entryFile: 'SKILL.md',
          files: [
            {
              path: 'SKILL.md',
              kind: 'markdown',
              content: '不应出现的提示词',
            },
          ],
          isBuiltIn: false,
          enabled: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]
      const prompt = buildAgentSystemPrompt(skills, '')
      expect(prompt).not.toContain('不应出现的提示词')
      expect(prompt).toContain('【Agent 智能体模式已启用】')
    })
  })

  describe('Validation of Agent Mode in Chat Request and Settings', () => {
    it('validates agentMode and skillIds in chat request', () => {
      const messages = [
        {
          id: 'msg-1',
          role: 'user' as const,
          content: '你好',
          createdAt: new Date().toISOString(),
        },
      ]
      expect(() =>
        validateChatRequest({
          conversationId: 'c1',
          modelId: 'm1',
          messages,
          reasoningEnabled: false,
          agentMode: true,
          skillIds: ['code-interpreter', 'web-extractor'],
        }),
      ).not.toThrow()
    })

    it('rejects more pinned Skills than the persisted activation limit', () => {
      expect(() =>
        validateChatRequest({
          conversationId: 'c1',
          modelId: 'm1',
          messages: [{ id: 'msg-1', role: 'user', content: 'hello', createdAt: new Date().toISOString() }],
          reasoningEnabled: false,
          agentMode: true,
          skillIds: Array.from({ length: 51 }, (_, index) => `skill-${index}`),
        }),
      ).toThrow()
    })

    it('rejects invalid agentMode type', () => {
      const messages = [
        {
          id: 'msg-1',
          role: 'user' as const,
          content: '你好',
          createdAt: new Date().toISOString(),
        },
      ]
      expect(() =>
        validateChatRequest({
          conversationId: 'c1',
          modelId: 'm1',
          messages,
          reasoningEnabled: false,
          agentMode: 'invalid' as any,
        } as any),
      ).toThrow('Agent 模式配置无效。')
    })

    it('normalizes defaultAgentMode in app settings', () => {
      const normalized = normalizeAppSettings({
        theme: 'system',
        sendShortcut: 'enter',
        contextManagementMode: 'manual',
        defaultModelId: 'openrouter-auto',
        defaultReasoningEnabled: false,
        defaultReasoningEffort: 'medium',
        defaultAgentMode: true,
        systemPrompt: '',
        proxy: { mode: 'off', url: '' },
      })
      expect(normalized.defaultAgentMode).toBe(true)

      const normalizedDefault = normalizeAppSettings({
        theme: 'system',
        sendShortcut: 'enter',
        contextManagementMode: 'manual',
        defaultModelId: 'openrouter-auto',
        defaultReasoningEnabled: false,
        defaultReasoningEffort: 'medium',
        systemPrompt: '',
        proxy: { mode: 'off', url: '' },
      })
      expect(normalizedDefault.defaultAgentMode).toBe(false)
    })
  })
})
