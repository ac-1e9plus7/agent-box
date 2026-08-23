import type { McpToolDefinition, Skill } from './types'
import { t } from "./i18n"

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

export const BUILTIN_AGENT_TOOL_SERVER_IDS: ReadonlySet<string> = new Set([
  SKILL_LOADER_SERVER_ID,
  CODE_RUNNER_SERVER_ID,
  TERMINAL_RUNNER_SERVER_ID,
  WORKSPACE_FILES_SERVER_ID,
])

export function createSkillLoaderTool(skills: Skill[]): McpToolDefinition | undefined {
  if (skills.length === 0) return undefined
  return {
    name: SKILL_LOADER_TOOL_NAME,
    modelName: SKILL_LOADER_MODEL_NAME,
    description: t("按技能 ID 加载一个本地只读技能的完整 SKILL.md、参考文档和参考脚本。仅在当前已激活技能不足以完成任务时调用；该工具不会执行脚本。"),
    inputSchema: {
      type: 'object',
      properties: {
        skill_id: {
          type: 'string',
          enum: skills.map((skill) => skill.id),
          description: t("可用技能目录中的技能 ID。"),
        },
      },
      required: ['skill_id'],
      additionalProperties: false,
    },
    annotations: {
      title: t("加载技能"),
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
    description: t("执行短小、无外部依赖的算法或数据验证代码。JavaScript 在隔离 Worker 中运行；Python 仅在本机存在 Python 3 时运行。执行可能消耗本机资源，通常需要用户审批。"),
    inputSchema: {
      type: 'object',
      properties: {
        language: {
          type: 'string',
          enum: ['javascript', 'python'],
          description: t("优先使用 javascript 保证可用；只有用户明确需要 Python 或代码必须使用 Python 时才选择 python。"),
        },
        code: { type: 'string', minLength: 1, maxLength: 100_000 },
        input: { description: t("可选 JSON 输入；JavaScript 中通过 input、Python 中通过 input_data 访问。") },
        timeout_seconds: { type: 'number', minimum: 0.5, maximum: 20 },
      },
      required: ['language', 'code'],
      additionalProperties: false,
    },
    annotations: {
      title: t("运行代码"),
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
    description: t("在用户配置的 Integrated terminal shell 中执行一条命令。Shell 会按操作系统自动选择，也可在设置中指定可执行文件和启动参数。终端命令属于敏感操作，通常需要用户审批。"),
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
      title: t("集成终端命令"),
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
      description: t("读取当前会话工作目录内的 UTF-8 文本文件。path 必须是相对工作目录的路径；支持按行分段读取。优先使用此工具读取源码和配置文件，避免通过 Shell 输出导致转义或截断。"),
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1, maxLength: 4_096, description: t("相对于当前工作目录的文件路径。") },
          start_line: { type: 'integer', minimum: 1, description: t("从第几行开始读取，默认为 1。") },
          max_lines: { type: 'integer', minimum: 1, maximum: 2_000, description: t("最多读取多少行，默认为 400。") },
        },
        required: ['path'],
        additionalProperties: false,
      },
      annotations: {
        title: t("读取工作区文件"),
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
      description: t("将文本直接写入当前会话工作目录内的文件，不经过 Shell，因此换行、引号、反引号和 $ 等代码字符不会被二次解释。path 必须是相对路径；可自动创建父目录。写入后应按需调用读取工具验证。"),
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1, maxLength: 4_096, description: t("相对于当前工作目录的目标文件路径。") },
          content: { type: 'string', maxLength: 100_000, description: t("要按 UTF-8 原样写入的完整文本内容；超长文件请拆分后使用 append。") },
          mode: {
            type: 'string',
            enum: ['create', 'overwrite', 'append'],
            description: t("create 仅新建、overwrite 覆盖或新建（默认）、append 追加。"),
          },
          create_parent_directories: { type: 'boolean', description: t("父目录不存在时是否自动创建，默认为 true。") },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      annotations: {
        title: t("写入工作区文件"),
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
