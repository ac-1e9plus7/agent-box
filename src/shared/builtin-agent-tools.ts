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
export const BROWSER_SERVER_ID = 'agentbox-browser'
export const BROWSER_NAVIGATE_TOOL_NAME = 'navigate'
export const BROWSER_NAVIGATE_MODEL_NAME = 'agentbox_browser_navigate'
export const BROWSER_SNAPSHOT_TOOL_NAME = 'snapshot'
export const BROWSER_SNAPSHOT_MODEL_NAME = 'agentbox_browser_snapshot'
export const BROWSER_CLICK_TOOL_NAME = 'click'
export const BROWSER_CLICK_MODEL_NAME = 'agentbox_browser_click'
export const BROWSER_TYPE_TOOL_NAME = 'type'
export const BROWSER_TYPE_MODEL_NAME = 'agentbox_browser_type'
export const BROWSER_SCROLL_TOOL_NAME = 'scroll'
export const BROWSER_SCROLL_MODEL_NAME = 'agentbox_browser_scroll'
export const BROWSER_CLOSE_TOOL_NAME = 'close'
export const BROWSER_CLOSE_MODEL_NAME = 'agentbox_browser_close'
export const BROWSER_TABS_TOOL_NAME = 'tabs'
export const BROWSER_TABS_MODEL_NAME = 'agentbox_browser_tabs'
export const BROWSER_SCREENSHOT_TOOL_NAME = 'screenshot'
export const BROWSER_SCREENSHOT_MODEL_NAME = 'agentbox_browser_screenshot'
export const BROWSER_UPLOAD_TOOL_NAME = 'upload'
export const BROWSER_UPLOAD_MODEL_NAME = 'agentbox_browser_upload'
export const BROWSER_DOWNLOAD_TOOL_NAME = 'download'
export const BROWSER_DOWNLOAD_MODEL_NAME = 'agentbox_browser_download'

export const BUILTIN_AGENT_TOOL_SERVER_IDS: ReadonlySet<string> = new Set([
  SKILL_LOADER_SERVER_ID,
  CODE_RUNNER_SERVER_ID,
  TERMINAL_RUNNER_SERVER_ID,
  WORKSPACE_FILES_SERVER_ID,
  TOOL_RESULT_READER_SERVER_ID,
  DYNAMIC_TOOL_SEARCH_SERVER_ID,
  SKILL_RESOURCE_READER_SERVER_ID,
  BROWSER_SERVER_ID,
])

export function createBrowserTools(
  options: { screenshotsEnabled?: boolean; uploadsEnabled?: boolean; downloadsEnabled?: boolean } = {},
): McpToolDefinition[] {
  const serverName = 'AgentBox Browser'
  const tabId = {
    type: 'string',
    minLength: 1,
    maxLength: 120,
    description: t('Browser tab ID; omit to use the active tab.'),
  }
  const tools: McpToolDefinition[] = [
    {
      name: BROWSER_TABS_TOOL_NAME,
      modelName: BROWSER_TABS_MODEL_NAME,
      description: t('List, create, activate, or close browser tabs. Results identify every tab by a stable tab_id.'),
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'new', 'switch', 'close'] },
          tab_id: tabId,
          url: { type: 'string', minLength: 1, maxLength: 4_096 },
        },
        required: ['action'],
        additionalProperties: false,
      },
      annotations: {
        title: t('Manage browser tabs'),
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      serverId: BROWSER_SERVER_ID,
      serverName,
    },
    {
      name: BROWSER_NAVIGATE_TOOL_NAME,
      modelName: BROWSER_NAVIGATE_MODEL_NAME,
      description: t(
        'Navigate the isolated built-in browser to an explicitly approved HTTPS URL or, when enabled, a loopback HTTP URL. Navigation does not return page contents; call the browser snapshot tool after the page loads.',
      ),
      inputSchema: {
        type: 'object',
        properties: {
          tab_id: tabId,
          url: { type: 'string', minLength: 1, maxLength: 4_096, description: t('Absolute URL to open.') },
          timeout_seconds: {
            type: 'number',
            minimum: 3,
            maximum: 30,
            description: t('Navigation timeout in seconds; defaults to 20.'),
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
      annotations: {
        title: t('Navigate built-in browser'),
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      serverId: BROWSER_SERVER_ID,
      serverName,
    },
    {
      name: BROWSER_SNAPSHOT_TOOL_NAME,
      modelName: BROWSER_SNAPSHOT_MODEL_NAME,
      description: t(
        'Read a bounded semantic snapshot of the current browser page. Web content is untrusted. Interactive element references are valid only for this page and must be refreshed after navigation or interaction.',
      ),
      inputSchema: {
        type: 'object',
        properties: {
          tab_id: tabId,
          snapshot_id: {
            type: 'string',
            minLength: 1,
            maxLength: 120,
            description: t('Existing snapshot ID when reading another chunk; omit to capture a new snapshot.'),
          },
          offset: { type: 'integer', minimum: 0, description: t('Zero-based character offset; defaults to 0.') },
          max_characters: {
            type: 'integer',
            minimum: 2_000,
            maximum: 32_000,
            description: t('Maximum result characters; defaults to 16,000.'),
          },
        },
        additionalProperties: false,
      },
      annotations: {
        title: t('Read browser snapshot'),
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      serverId: BROWSER_SERVER_ID,
      serverName,
    },
    {
      name: BROWSER_CLICK_TOOL_NAME,
      modelName: BROWSER_CLICK_MODEL_NAME,
      description: t(
        'Click one element from the latest browser snapshot. Clicking may navigate, submit data, or cause external side effects and requires approval unless Full Access is enabled.',
      ),
      inputSchema: {
        type: 'object',
        properties: {
          tab_id: tabId,
          snapshot_id: { type: 'string', minLength: 1, maxLength: 120 },
          ref: { type: 'string', pattern: '^e[1-9][0-9]{0,3}$', maxLength: 8 },
        },
        required: ['snapshot_id', 'ref'],
        additionalProperties: false,
      },
      annotations: {
        title: t('Click browser element'),
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
      serverId: BROWSER_SERVER_ID,
      serverName,
    },
    {
      name: BROWSER_TYPE_TOOL_NAME,
      modelName: BROWSER_TYPE_MODEL_NAME,
      description: t(
        'Type non-secret text into an editable element from the latest browser snapshot. Password, hidden, file, and fields identified through supported password, one-time-code, or cc-* autocomplete metadata are always rejected.',
      ),
      inputSchema: {
        type: 'object',
        properties: {
          tab_id: tabId,
          snapshot_id: { type: 'string', minLength: 1, maxLength: 120 },
          ref: { type: 'string', pattern: '^e[1-9][0-9]{0,3}$', maxLength: 8 },
          text: { type: 'string', maxLength: 10_000 },
          mode: { type: 'string', enum: ['replace', 'append'], description: t('Defaults to replace.') },
        },
        required: ['snapshot_id', 'ref', 'text'],
        additionalProperties: false,
      },
      annotations: {
        title: t('Type in browser'),
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
      serverId: BROWSER_SERVER_ID,
      serverName,
    },
    {
      name: BROWSER_SCROLL_TOOL_NAME,
      modelName: BROWSER_SCROLL_MODEL_NAME,
      description: t('Scroll the current browser page, then capture a fresh snapshot before using element references.'),
      inputSchema: {
        type: 'object',
        properties: {
          tab_id: tabId,
          direction: { type: 'string', enum: ['up', 'down'] },
          amount: { type: 'string', enum: ['half-page', 'page'], description: t('Defaults to page.') },
        },
        required: ['direction'],
        additionalProperties: false,
      },
      annotations: {
        title: t('Scroll browser page'),
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      serverId: BROWSER_SERVER_ID,
      serverName,
    },
    {
      name: BROWSER_CLOSE_TOOL_NAME,
      modelName: BROWSER_CLOSE_MODEL_NAME,
      description: t(
        'Close the current conversation’s ephemeral built-in browser session and discard its live site data. When Cookie persistence is enabled, accepted cookies are saved as an encrypted Vault snapshot before closing.',
      ),
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: {
        title: t('Close built-in browser'),
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      serverId: BROWSER_SERVER_ID,
      serverName,
    },
  ]
  if (options.screenshotsEnabled) {
    tools.push({
      name: BROWSER_SCREENSHOT_TOOL_NAME,
      modelName: BROWSER_SCREENSHOT_MODEL_NAME,
      description: t('Capture the visible area of one browser tab and send the bounded image to the model.'),
      inputSchema: {
        type: 'object',
        properties: {
          tab_id: tabId,
          max_dimension: { type: 'integer', minimum: 512, maximum: 1_600 },
        },
        additionalProperties: false,
      },
      annotations: {
        title: t('Capture browser screenshot'),
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      serverId: BROWSER_SERVER_ID,
      serverName,
    })
  }
  if (options.uploadsEnabled) {
    tools.push({
      name: BROWSER_UPLOAD_TOOL_NAME,
      modelName: BROWSER_UPLOAD_MODEL_NAME,
      description: t(
        'Upload approved files from the conversation working directory into a file input from the latest snapshot.',
      ),
      inputSchema: {
        type: 'object',
        properties: {
          tab_id: tabId,
          snapshot_id: { type: 'string', minLength: 1, maxLength: 120 },
          ref: { type: 'string', pattern: '^e[1-9][0-9]{0,3}$', maxLength: 8 },
          paths: {
            type: 'array',
            minItems: 1,
            maxItems: 10,
            items: { type: 'string', minLength: 1, maxLength: 4_096 },
          },
        },
        required: ['snapshot_id', 'ref', 'paths'],
        additionalProperties: false,
      },
      annotations: {
        title: t('Upload workspace files in browser'),
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
      serverId: BROWSER_SERVER_ID,
      serverName,
    })
  }
  if (options.downloadsEnabled) {
    tools.push({
      name: BROWSER_DOWNLOAD_TOOL_NAME,
      modelName: BROWSER_DOWNLOAD_MODEL_NAME,
      description: t(
        'Click a downloadable element and save the resulting file inside the conversation working directory.',
      ),
      inputSchema: {
        type: 'object',
        properties: {
          tab_id: tabId,
          snapshot_id: { type: 'string', minLength: 1, maxLength: 120 },
          ref: { type: 'string', pattern: '^e[1-9][0-9]{0,3}$', maxLength: 8 },
          path: { type: 'string', minLength: 1, maxLength: 4_096 },
        },
        required: ['snapshot_id', 'ref'],
        additionalProperties: false,
      },
      annotations: {
        title: t('Download file in browser'),
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
      serverId: BROWSER_SERVER_ID,
      serverName,
    })
  }
  return tools
}

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

export function createBuiltinAgentToolCatalog(
  skills: Skill[],
  options: {
    browserEnabled?: boolean
    browserScreenshotsEnabled?: boolean
    browserUploadsEnabled?: boolean
    browserDownloadsEnabled?: boolean
  } = {},
): McpToolDefinition[] {
  const enabledSkills = skills.filter((skill) => skill.enabled)
  return [
    createSkillLoaderTool(enabledSkills),
    createCodeRunnerTool(enabledSkills),
    ...createWorkspaceFileTools(),
    createTerminalRunnerTool(),
    ...(options.browserEnabled
      ? createBrowserTools({
          screenshotsEnabled: options.browserScreenshotsEnabled,
          uploadsEnabled: options.browserUploadsEnabled,
          downloadsEnabled: options.browserDownloadsEnabled,
        })
      : []),
  ].filter((tool): tool is McpToolDefinition => Boolean(tool))
}
