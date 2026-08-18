import { describe, expect, it } from 'vitest'
import { retrieveRelevantTools } from '../src/electron/mcp/tool-retriever'
import type { McpToolDefinition } from '../src/shared/types'

describe('retrieveRelevantTools', () => {
  const sampleTools: McpToolDefinition[] = [
    {
      name: 'read_file',
      description: 'Read the contents of a file from filesystem',
      inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'file path' } } },
      serverId: 'fs',
      serverName: 'Filesystem',
    },
    {
      name: 'write_file',
      description: 'Write text content to a destination file on disk',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
      serverId: 'fs',
      serverName: 'Filesystem',
    },
    {
      name: 'calculate_mortgage',
      description: 'Compute monthly loan payments and interest rates for real estate',
      inputSchema: { type: 'object', properties: { principal: { type: 'number' }, rate: { type: 'number' } } },
      serverId: 'calc',
      serverName: 'Calculator',
    },
    {
      name: 'git_status',
      description: 'Check working repository status and modified git branches',
      inputSchema: { type: 'object', properties: { repo: { type: 'string' } } },
      serverId: 'git',
      serverName: 'Git',
    },
    {
      name: 'query_database',
      description: 'Execute SQL select statement on PostgreSQL database',
      inputSchema: { type: 'object', properties: { sql: { type: 'string' } } },
      serverId: 'db',
      serverName: 'Database',
    },
    {
      name: 'fetch_weather',
      description: 'Get current temperature and forecast for a city',
      inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
      serverId: 'weather',
      serverName: 'Weather',
    },
    {
      name: 'send_email',
      description: 'Send an email via SMTP server',
      inputSchema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' } } },
      serverId: 'mail',
      serverName: 'Mail',
    },
  ]

  it('returns all tools if count is less than or equal to maxTools', () => {
    const small = sampleTools.slice(0, 3)
    const res = retrieveRelevantTools('anything', small, { maxTools: 5 })
    expect(res).toHaveLength(3)
  })

  it('returns all tools when mode is all', () => {
    const res = retrieveRelevantTools('weather in Paris', sampleTools, { mode: 'all', maxTools: 3 })
    expect(res).toHaveLength(sampleTools.length)
  })

  it('ranks exact and relevant tools at the top for filesystem query', () => {
    const res = retrieveRelevantTools('Please read the file at src/index.ts', sampleTools, { mode: 'auto', maxTools: 2 })
    expect(res).toHaveLength(2)
    expect(res[0]?.name).toBe('read_file')
  })

  it('ranks weather tool first for weather query', () => {
    const res = retrieveRelevantTools('What is the weather in Tokyo today?', sampleTools, { mode: 'auto', maxTools: 3 })
    expect(res[0]?.name).toBe('fetch_weather')
  })

  it('ranks git tool first for git query', () => {
    const res = retrieveRelevantTools('Check git status and modified files in repository', sampleTools, { mode: 'auto', maxTools: 3 })
    expect(res[0]?.name).toBe('git_status')
  })
})
