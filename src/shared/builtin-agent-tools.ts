import type { McpToolDefinition, Skill } from './types'
import { t } from './i18n'

export const SKILL_LOADER_SERVER_ID = 'agentbox-skills'
export const SKILL_LOADER_TOOL_NAME = 'load_skill'
export const SKILL_LOADER_MODEL_NAME = 'agentbox_load_skill'
export const CODE_RUNNER_SERVER_ID = 'agentbox-code-runner'
export const CODE_RUNNER_TOOL_NAME = 'run_code'
export const CODE_RUNNER_MODEL_NAME = 'agentbox_run_code'
export const TERMINAL_RUNNER_SERVER_ID = 'agentbox-integrated-terminal'
export const TERMINAL_RUNNER_TOOL_NAME = 'run_terminal'
export const TERMINAL_RUNNER_MODEL_NAME = 'agentbox_run_terminal'
export const WORKSPACE_FILES_SERVER_ID = 'agentbox-workspace-files'
export const WORKSPACE_READ_FILE_TOOL_NAME = 'read_file'
export const WORKSPACE_READ_FILE_MODEL_NAME = 'agentbox_read_file'
export const WORKSPACE_WRITE_FILE_TOOL_NAME = 'write_file'
export const WORKSPACE_WRITE_FILE_MODEL_NAME = 'agentbox_write_file'
export const TOOL_RESULT_READER_SERVER_ID = 'agentbox-tool-results'
export const TOOL_RESULT_READER_TOOL_NAME = 'read_tool_result'
export const TOOL_RESULT_READER_MODEL_NAME = 'agentbox_read_tool_result'
export const DYNAMIC_TOOL_SEARCH_SERVER_ID = 'agentbox-tool-search'
export const DYNAMIC_TOOL_SEARCH_TOOL_NAME = 'search_tools'
export const DYNAMIC_TOOL_SEARCH_MODEL_NAME = 'agentbox_search_tools'
export const SKILL_RESOURCE_READER_SERVER_ID = 'agentbox-skill-resources'
export const SKILL_RESOURCE_READER_TOOL_NAME = 'read_skill_resource'
export const SKILL_RESOURCE_READER_MODEL_NAME = 'agentbox_read_skill_resource'

export const BUILTIN_AGENT_TOOL_SERVER_IDS: ReadonlySet<string> = new Set([
  SKILL_LOADER_SERVER_ID,
  CODE_RUNNER_SERVER_ID,
  TERMINAL_RUNNER_SERVER_ID,
  WORKSPACE_FILES_SERVER_ID,
  TOOL_RESULT_READER_SERVER_ID,
  DYNAMIC_TOOL_SEARCH_SERVER_ID,
  SKILL_RESOURCE_READER_SERVER_ID,
])

export function createToolResultReaderTool(): McpToolDefinition {
  return {
    name: TOOL_RESULT_READER_TOOL_NAME,
    modelName: TOOL_RESULT_READER_MODEL_NAME,
    description: t(
      'Read a chunk of a complete tool result that was shortened in model-visible history. Use the call_id from the compaction marker and advance offset until has_more is false.',
    ),
    inputSchema: {
      type: 'object',
      properties: {
        call_id: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: t('Tool call ID from a compacted result marker.'),
        },
        offset: {
          type: 'integer',
          minimum: 0,
          description: t('Zero-based character offset; defaults to 0.'),
        },
        max_characters: {
          type: 'integer',
          minimum: 256,
          maximum: 32_000,
          description: t('Maximum number of result characters to return; defaults to 8,000.'),
        },
      },
      required: ['call_id'],
      additionalProperties: false,
    },
    annotations: {
      title: t('Read complete tool result'),
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    serverId: TOOL_RESULT_READER_SERVER_ID,
    serverName: 'AgentBox Tool Results',
  }
}

export function createDynamicToolSearchTool(): McpToolDefinition {
  return {
    name: DYNAMIC_TOOL_SEARCH_TOOL_NAME,
    modelName: DYNAMIC_TOOL_SEARCH_MODEL_NAME,
    description: t(
      'Search the authorized built-in and MCP tool catalog and expose matching tools on the next model turn. Use this when the initially exposed tools are insufficient. Searching does not execute a matched tool.',
    ),
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          maxLength: 2_000,
          description: t('Describe the capability or tool name needed for the next step.'),
        },
        max_tools: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: t('Maximum matching tools to expose on the next turn.'),
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: {
      title: t('Search and expose tools'),
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    serverId: DYNAMIC_TOOL_SEARCH_SERVER_ID,
    serverName: 'AgentBox Tool Search',
  }
}

export function createSkillResourceReaderTool(): McpToolDefinition {
  return {
    name: SKILL_RESOURCE_READER_TOOL_NAME,
    modelName: SKILL_RESOURCE_READER_MODEL_NAME,
    description: t(
      'Read a chunk of an active Skill reference document or reference script by its exact manifest path. This read-only tool never executes scripts.',
    ),
    inputSchema: {
      type: 'object',
      properties: {
        skill_id: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          description: t('Active Skill ID shown in the Skill header.'),
        },
        path: {
          type: 'string',
          minLength: 1,
          maxLength: 255,
          description: t('Exact markdown, Python, or shell resource path from the active Skill manifest.'),
        },
        offset: {
          type: 'integer',
          minimum: 0,
          description: t('Zero-based character offset; defaults to 0.'),
        },
        max_characters: {
          type: 'integer',
          minimum: 256,
          maximum: 32_000,
          description: t('Maximum number of resource characters to return; defaults to 8,000.'),
        },
      },
      required: ['skill_id', 'path'],
      additionalProperties: false,
    },
    annotations: {
      title: t('Read Skill resource'),
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    serverId: SKILL_RESOURCE_READER_SERVER_ID,
    serverName: 'AgentBox Skill Resources',
  }
}

export function createSkillLoaderTool(skills: Skill[]): McpToolDefinition | undefined {
  if (skills.length === 0) return undefined
  return {
    name: SKILL_LOADER_TOOL_NAME,
    modelName: SKILL_LOADER_MODEL_NAME,
    description: t(
      'Load a local read-only Skill’s complete SKILL.md, reference documents, and reference scripts by Skill ID. Use it only when the active Skills are insufficient for the task. This tool never executes scripts.',
    ),
    inputSchema: {
      type: 'object',
      properties: {
        skill_id: {
          type: 'string',
          enum: skills.map((skill) => skill.id),
          description: t('Skill ID from the available skills catalog.'),
        },
      },
      required: ['skill_id'],
      additionalProperties: false,
    },
    annotations: {
      title: t('Load skill'),
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    serverId: SKILL_LOADER_SERVER_ID,
    serverName: 'AgentBox Skills',
  }
}

export function createCodeRunnerTool(skills: Skill[]): McpToolDefinition | undefined {
  if (!skills.some((skill) => skill.files.some((file) => file.kind === 'python'))) return undefined
  return {
    name: CODE_RUNNER_TOOL_NAME,
    modelName: CODE_RUNNER_MODEL_NAME,
    description: t(
      'Run short, dependency-free code for algorithms or data validation. JavaScript runs in an isolated worker; Python runs only when Python 3 is installed locally. Execution can consume local system resources and usually requires user approval.',
    ),
    inputSchema: {
      type: 'object',
      properties: {
        language: {
          type: 'string',
          enum: ['javascript', 'python'],
          description: t(
            'Prioritize using javascript to ensure availability; only choose python when the user clearly needs Python or the code must use Python.',
          ),
        },
        code: { type: 'string', minLength: 1, maxLength: 100_000 },
        input: { description: t('Optional JSON input; accessed via input in JavaScript or input_data in Python.') },
        timeout_seconds: { type: 'number', minimum: 0.5, maximum: 20 },
      },
      required: ['language', 'code'],
      additionalProperties: false,
    },
    annotations: {
      title: t('Run code'),
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    serverId: CODE_RUNNER_SERVER_ID,
    serverName: 'AgentBox Code Runner',
  }
}

export function createTerminalRunnerTool(): McpToolDefinition {
  return {
    name: TERMINAL_RUNNER_TOOL_NAME,
    modelName: TERMINAL_RUNNER_MODEL_NAME,
    description: t(
      "Execute a command in the user's configured Integrated terminal shell. The shell is automatically selected by operating system, or the executable and startup parameters can be specified in settings. Terminal commands are sensitive operations and usually require user approval.",
    ),
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1, maxLength: 100_000 },
        timeout_seconds: { type: 'number', minimum: 0.5, maximum: 60 },
      },
      required: ['command'],
      additionalProperties: false,
    },
    annotations: {
      title: t('Integrated terminal command'),
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    serverId: TERMINAL_RUNNER_SERVER_ID,
    serverName: 'AgentBox Integrated Terminal',
  }
}

export function createWorkspaceFileTools(): McpToolDefinition[] {
  return [
    {
      name: WORKSPACE_READ_FILE_TOOL_NAME,
      modelName: WORKSPACE_READ_FILE_MODEL_NAME,
      description: t(
        "Reads a UTF-8 text file in the current conversation's working directory. path must be a path relative to the working directory; segmented reading by line is supported. Prioritize using this tool to read source code and configuration files to avoid escaping or truncation through shell output.",
      ),
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            minLength: 1,
            maxLength: 4_096,
            description: t('File path relative to the current working directory.'),
          },
          start_line: {
            type: 'integer',
            minimum: 1,
            description: t('Line number to start reading from, default is 1.'),
          },
          max_lines: {
            type: 'integer',
            minimum: 1,
            maximum: 2_000,
            description: t('The maximum number of lines to read, the default is 400.'),
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      annotations: {
        title: t('Read workspace file'),
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      serverId: WORKSPACE_FILES_SERVER_ID,
      serverName: 'AgentBox Workspace Files',
    },
    {
      name: WORKSPACE_WRITE_FILE_TOOL_NAME,
      modelName: WORKSPACE_WRITE_FILE_MODEL_NAME,
      description: t(
        "Writes text directly to a file in the current conversation's working directory, without going through the shell, so code characters such as newlines, quotes, backticks, and $ are not interpreted twice. path must be a relative path; parent directories are automatically created. Read tool verification should be called as needed after writing.",
      ),
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            minLength: 1,
            maxLength: 4_096,
            description: t('The target file path relative to the current working directory.'),
          },
          content: {
            type: 'string',
            maxLength: 100_000,
            description: t(
              'The complete text content to be written as UTF-8; for extremely long files, please split them and use append.',
            ),
          },
          mode: {
            type: 'string',
            enum: ['create', 'overwrite', 'append'],
            description: t(
              'create creates a new file only; overwrite replaces or creates a file (default); append adds content to the end.',
            ),
          },
          create_parent_directories: {
            type: 'boolean',
            description: t('Create missing parent directories; defaults to true.'),
          },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      annotations: {
        title: t('Write to workspace file'),
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
      serverId: WORKSPACE_FILES_SERVER_ID,
      serverName: 'AgentBox Workspace Files',
    },
  ]
}

export function createBuiltinAgentToolCatalog(skills: Skill[]): McpToolDefinition[] {
  const enabledSkills = skills.filter((skill) => skill.enabled)
  return [
    createSkillLoaderTool(enabledSkills),
    createCodeRunnerTool(enabledSkills),
    ...createWorkspaceFileTools(),
    createTerminalRunnerTool(),
  ].filter((tool): tool is McpToolDefinition => Boolean(tool))
}
