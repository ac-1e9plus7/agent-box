import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv'
import type { McpToolApprovalPolicy, McpToolDefinition } from '../../shared/types'

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true })
const validatorCache = new Map<string, ValidateFunction>()

export function validateToolArguments(
  tool: McpToolDefinition,
  args: unknown,
): { ok: true; args: Record<string, unknown> } | { ok: false; message: string } {
  if (!isRecord(args)) return { ok: false, message: '工具参数必须是 JSON 对象。' }
  try {
    const key = `${tool.serverId}:${tool.name}:${JSON.stringify(tool.inputSchema)}`
    let validator = validatorCache.get(key)
    if (!validator) {
      if (validatorCache.size > 500) validatorCache.clear()
      validator = ajv.compile(tool.inputSchema)
      validatorCache.set(key, validator)
    }
    if (validator(args)) return { ok: true, args }
    return { ok: false, message: formatValidationErrors(validator.errors) }
  } catch (error) {
    return {
      ok: false,
      message: `工具参数 Schema 无法验证：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export function evaluateToolApproval(
  policy: McpToolApprovalPolicy,
  tool: McpToolDefinition,
): { required: boolean; riskLevel: 'low' | 'sensitive'; reason: string } {
  const annotations = tool.annotations
  const explicitlyLowRisk = annotations?.readOnlyHint === true
    && annotations.destructiveHint === false
    && annotations.openWorldHint === false
  const riskLevel = explicitlyLowRisk ? 'low' : 'sensitive'
  const reason = explicitlyLowRisk
    ? '服务声明该工具只读、非破坏性且不访问开放外部环境。'
    : '该工具可能写入数据、访问外部系统，或未提供完整的只读安全声明。'
  if (policy === 'full-access') return { required: false, riskLevel, reason }
  if (policy === 'always') return { required: true, riskLevel, reason }
  return { required: !explicitlyLowRisk, riskLevel, reason }
}

function formatValidationErrors(errors?: ErrorObject[] | null): string {
  if (!errors?.length) return '工具参数不符合 JSON Schema。'
  return `工具参数不符合 JSON Schema：${errors.slice(0, 5).map((error) => `${error.instancePath || '/'} ${error.message || '无效'}`).join('；')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
