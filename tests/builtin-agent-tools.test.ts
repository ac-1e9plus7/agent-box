import { describe, expect, it } from 'vitest'
import { BUILTIN_AGENT_TOOL_SERVER_IDS, createBuiltinAgentToolCatalog } from '../src/shared/builtin-agent-tools'
import type { Skill } from '../src/shared/types'

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: 'data-analysis',
    name: 'Data Analysis',
    description: 'Analyze data',
    entryFile: 'SKILL.md',
    files: [
      { path: 'SKILL.md', content: '# Data Analysis', kind: 'markdown' },
      { path: 'scripts/analyze.py', content: 'print(1)', kind: 'python' },
    ],
    enabled: true,
    ...overrides,
  }
}

describe('built-in Agent tool catalog', () => {
  it('lists every runtime built-in tool, including workspace file reading and writing', () => {
    const tools = createBuiltinAgentToolCatalog([makeSkill()])

    expect(tools.map((tool) => tool.modelName)).toEqual([
      'agentbox_load_skill',
      'agentbox_run_code',
      'agentbox_read_file',
      'agentbox_write_file',
      'agentbox_run_terminal',
    ])
    expect(tools.every((tool) => BUILTIN_AGENT_TOOL_SERVER_IDS.has(tool.serverId))).toBe(true)
    expect(tools.find((tool) => tool.modelName === 'agentbox_read_file')?.annotations?.readOnlyHint).toBe(true)
    expect(tools.find((tool) => tool.modelName === 'agentbox_write_file')?.annotations?.destructiveHint).toBe(true)
  })

  it('only advertises skill-dependent tools when an enabled skill makes them available', () => {
    const tools = createBuiltinAgentToolCatalog([makeSkill({ enabled: false })])

    expect(tools.map((tool) => tool.modelName)).toEqual([
      'agentbox_read_file',
      'agentbox_write_file',
      'agentbox_run_terminal',
    ])
  })

  it('advertises the isolated browser family only when the feature is enabled', () => {
    const disabled = createBuiltinAgentToolCatalog([makeSkill()])
    const enabled = createBuiltinAgentToolCatalog([makeSkill()], { browserEnabled: true })

    expect(disabled.some((tool) => tool.serverId === 'agentbox-browser')).toBe(false)
    expect(enabled.filter((tool) => tool.serverId === 'agentbox-browser').map((tool) => tool.modelName)).toEqual([
      'agentbox_browser_tabs',
      'agentbox_browser_navigate',
      'agentbox_browser_snapshot',
      'agentbox_browser_click',
      'agentbox_browser_type',
      'agentbox_browser_scroll',
      'agentbox_browser_close',
    ])
  })

  it('adds screenshot, upload, and download tools only for their explicit settings', () => {
    const tools = createBuiltinAgentToolCatalog([makeSkill()], {
      browserEnabled: true,
      browserScreenshotsEnabled: true,
      browserUploadsEnabled: true,
      browserDownloadsEnabled: true,
    })
    expect(tools.filter((tool) => tool.serverId === 'agentbox-browser').map((tool) => tool.modelName)).toEqual(
      expect.arrayContaining(['agentbox_browser_screenshot', 'agentbox_browser_upload', 'agentbox_browser_download']),
    )
  })
})
