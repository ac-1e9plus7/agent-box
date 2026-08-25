import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv'
import type { McpToolApprovalPolicy, McpToolDefinition } from '../../shared/types'
import { t } from '../../shared/i18n'

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true })
const validatorCache = new Map<string, ValidateFunction>()

export function validateToolArguments(
  tool: McpToolDefinition,
  args: unknown,
): { ok: true; args: Record<string, unknown> } | { ok: false; message: string } {
  if (!isRecord(args)) return { ok: false, message: t('Tool parameters must be JSON objects.') }
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
      message: t('The tool parameter schema could not be validated: {value0}', {
        value0: error instanceof Error ? error.message : String(error),
      }),
    }
  }
}

export function evaluateToolApproval(
  policy: McpToolApprovalPolicy,
  tool: McpToolDefinition,
): { required: boolean; riskLevel: 'low' | 'sensitive'; reason: string } {
  const annotations = tool.annotations
  const explicitlyLowRisk =
    annotations?.readOnlyHint === true && annotations.destructiveHint === false && annotations.openWorldHint === false
  const riskLevel = explicitlyLowRisk ? 'low' : 'sensitive'
  const reason = explicitlyLowRisk
    ? t('The MCP server declares this tool read-only, non-destructive, and unable to interact with external systems.')
    : t(
        'This tool may modify data or interact with external systems, or the MCP server did not provide all low-risk annotations.',
      )
  if (policy === 'full-access') return { required: false, riskLevel, reason }
  if (policy === 'always') return { required: true, riskLevel, reason }
  return { required: !explicitlyLowRisk, riskLevel, reason }
}

function formatValidationErrors(errors?: ErrorObject[] | null): string {
  if (!errors?.length) return t('Tool parameters do not conform to the JSON Schema.')
  return t('Tool parameters do not conform to the JSON Schema: {value0}', {
    value0: errors
      .slice(0, 5)
      .map((error) => `${error.instancePath || '/'} ${error.message || t('invalid')}`)
      .join(t('; ')),
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
