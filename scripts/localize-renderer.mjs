import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

// Localization resource generator for the English-source-key scheme.
// English source copy is the message key; the Simplified Chinese bundle carries
// the translations. See docs/i18n.md for the workflow.
//
//   node scripts/localize-renderer.mjs generate   rebuild zh-CN.ts (MT en->zh) + en-US.ts
//   node scripts/localize-renderer.mjs check     fail on leaked CJK or unknown t() keys

const root = process.cwd()
const rendererRoot = path.join(root, 'src', 'renderer', 'src')
const sharedI18nRoot = path.join(root, 'src', 'shared', 'i18n')
const localesDir = path.join(sharedI18nRoot, 'locales')
const zhPath = path.join(localesDir, 'zh-CN.ts')
const enPath = path.join(localesDir, 'en-US.ts')
const defaultSkillsPath = path.join(root, 'src', 'electron', 'storage', 'default-skills.ts')
const command = process.argv[2]

// Semantic "hatch" keys: the only entries in the en-US bundle. Each is a case
// where one English string must render as different Chinese messages (e.g. the
// Chinese Agent resume phrases that all read "Continue"/"Try again"). The en
// value equals the shared English text; the zh value (in zh-CN.ts) distinguishes
// them. Add one only when a new such collision appears.
const SEMANTIC_KEYS = {
  'agentContinuation.tryAgainVariant1': 'Try again',
  'agentContinuation.tryAgainVariant2': 'Try again',
  'agentContinuation.tryAgainVariant3': 'Try again',
  'agentContinuation.continueVariant1': 'Continue',
  'agentContinuation.continueVariant2': 'Continue',
  'language.displayName': 'English',
  'stream.outputTruncatedLine': '[Output truncated]',
  'backup.exportEncrypted': 'Export backup',
  'modelPermissions.denyOption': 'Deny',
  'skillRetrieval.howVariant': 'how',
  'mcp.addServerHeading': 'Add MCP server',
  'conversation.newPlaceholder': 'New conversation',
  'agent.toolCallTurns': 'Agent tool-call limit',
  'provider.cliProxyLocalVariant': 'CLIProxyAPI (local)',
}

// Hand-reviewed English-key -> Chinese-value overrides for future copy. Promote a
// machine translation here once it has been reviewed; `generate` gives these
// entries highest priority over existing or machine-translated values.
const reviewedZh = {
  ', {value0}': '，{value0}',
  '; ': '；',
  '(empty)': '(空)',
  '{value0}: {value1}': '{value0}：{value1}',
  invalid: '无效',
  'Unable to update encrypted Agent recovery state ({value0}).': '无法更新加密的 Agent 恢复状态（{value0}）。',
  'Read a chunk of a complete tool result that was shortened in model-visible history. Use the call_id from the compaction marker and advance offset until has_more is false.':
    '读取在模型可见历史中被缩短的完整工具结果片段。请使用压缩标记中的 call_id，并递增 offset，直到 has_more 为 false。',
  'Tool call ID from a compacted result marker.': '压缩结果标记中的工具调用 ID。',
  'Zero-based character offset; defaults to 0.': '从 0 开始的字符偏移量；默认为 0。',
  'Maximum number of result characters to return; defaults to 8,000.': '返回的结果字符数上限；默认为 8,000。',
  'Read complete tool result': '读取完整工具结果',
  'Search the authorized built-in and MCP tool catalog and expose matching tools on the next model turn. Use this when the initially exposed tools are insufficient. Searching does not execute a matched tool.':
    '搜索本次请求已授权的内置和 MCP 工具目录，并在下一次模型轮次中挂载匹配的工具。当初始工具不足时使用。搜索本身不会执行匹配的工具。',
  'Describe the capability or tool name needed for the next step.': '描述下一步所需的能力或工具名称。',
  'Maximum matching tools to expose on the next turn.': '下一轮最多挂载的匹配工具数。',
  'Search and expose tools': '搜索并挂载工具',
  'Read a chunk of an active Skill reference document or reference script by its exact manifest path. This read-only tool never executes scripts.':
    '通过清单中的精确路径，分段读取已激活 Skill 的参考文档或参考脚本。此只读工具绝不会执行脚本。',
  'Active Skill ID shown in the Skill header.': 'Skill 标题中显示的已激活 Skill ID。',
  'Exact markdown, Python, or shell resource path from the active Skill manifest.':
    '已激活 Skill 资源清单中的精确 Markdown、Python 或 Shell 资源路径。',
  'Maximum number of resource characters to return; defaults to 8,000.': '返回的资源字符数上限；默认为 8,000。',
  'Read Skill resource': '读取 Skill 资源',
  'No complete tool result is available for call ID {value0}.': '没有可用的完整工具结果，调用 ID 为 {value0}。',
  'Read a previously completed local tool result without executing the tool again.':
    '读取之前已完成的本地工具结果，不重新执行该工具。',
  'The following authorized tools are now exposed for the next model turn:\n{value0}':
    '以下已授权工具现已挂载，供下一次模型轮次使用：\n{value0}',
  'No additional authorized tools matched this search.': '没有其他已授权工具匹配此搜索。',
  'Search the request-authorized local tool catalog without executing a matched tool.':
    '搜索本次请求已授权的本地工具目录，不执行匹配的工具。',
  'The requested active Skill resource was not found or is not readable.':
    '找不到请求的已激活 Skill 资源，或该资源不可读。',
  'Read a local active Skill reference resource without executing scripts.':
    '读取本地已激活 Skill 的参考资源，不执行脚本。',
  'Skill "{value0}" entry instructions and resource manifest have been loaded. Follow the entry instructions and read listed resources only when needed.':
    '已加载 Skill“{value0}”的入口指令和资源清单。请遵循入口指令，并仅在需要时读取清单中的资源。',
  '## Available Skill Resources (load only when needed):\n{value0}\nUse `{value1}` with this Skill ID and an exact path to read a resource in chunks. Python and shell resources are reference source and are never executed by this reader.':
    '## 可用 Skill 资源（仅在需要时加载）：\n{value0}\n使用 `{value1}` 并传入此 Skill ID 和精确路径，即可分段读取资源。Python 和 Shell 资源只是参考源码，此读取器绝不会执行它们。',
  'Agent token optimization': 'Agent Token 优化',
  'Compact tool results sent to the model': '压缩发送给模型的工具结果',
  'Keep complete tool output locally while limiting the text replayed to later model turns.':
    '本地保留完整工具输出，同时限制后续模型轮次中重放的文本长度。',
  'Maximum model-visible tool-result characters': '模型可见工具结果字符数上限',
  'Range: {minimum}–{maximum}. Default: {defaultValue}.': '范围：{minimum}–{maximum}。默认值：{defaultValue}。',
  characters: '字符',
  'Expose a smaller tool set dynamically': '动态挂载较小的工具集',
  'Start Agent runs with a limited tool set and make additional tools available on demand.':
    'Agent 运行开始时仅挂载有限工具，并按需提供其他工具。',
  'Initial dynamic tool limit': '初始动态工具上限',
  tools: '个工具',
  'Load Skill resources only when needed': '仅在需要时加载 Skill 资源',
  'Inject Skill entry instructions first, then load references and scripts on demand.':
    '先注入 Skill 入口指令，再按需加载参考资料和脚本。',
  'Compact long-running Agent context': '压缩长时间运行的 Agent 上下文',
  'Summarize older in-progress tool turns before the Agent fills the context window.':
    '在 Agent 填满上下文窗口前，汇总较早的执行中工具轮次。',
  'Context compaction threshold': '上下文压缩阈值',
  'Range: {minimum}%–{maximum}%. Default: {defaultValue}%.': '范围：{minimum}%–{maximum}%。默认值：{defaultValue}%。',
  'Recent Agent turns to keep': '保留的最近 Agent 轮次',
  'All Agent token optimizations are disabled by default and can be enabled independently.':
    '所有 Agent Token 优化默认关闭，可分别启用。',
  'Model requests: {value0}': '模型请求：{value0}',
  'Input {value0} tokens': '输入 {value0} tokens',
  'Output {value0} tokens': '输出 {value0} tokens',
  'Cached input {value0} tokens': '缓存命中输入 {value0} tokens',
  'Cache write {value0} tokens': '缓存写入 {value0} tokens',
  'Total token usage across all model requests': '所有模型请求的 Token 总用量',
  'Provider context reuse': '服务方上下文复用',
  'Reuse stable prefixes or provider-native response state. Unsupported modes automatically fall back to prefix caching and then stateless replay.':
    '复用稳定前缀或服务方原生响应状态。不支持的模式会自动降级为前缀缓存，再降级为无状态完整重放。',
  'Native continuation may retain provider-side response state according to the provider’s data policy.':
    '原生续接可能会按照服务方的数据政策保留服务方侧响应状态。',
  'Off (stateless replay)': '关闭（无状态重放）',
  'Automatic fallback': '自动选择并降级',
  'Prefix caching': '前缀缓存',
  'Native continuation': '原生续接',
  'The provider rejected every context reuse strategy.': '服务方拒绝了所有上下文复用策略。',
  'Only assistant messages can contain provider continuation state.': '只有助手消息可以包含服务方续接状态。',
  'Provider continuation state is invalid.': '服务方续接状态无效。',
}

// --- source file sets --------------------------------------------------------------
function sourceFiles(directory) {
  const result = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...sourceFiles(file))
    else if (/\.tsx?$/i.test(entry.name)) result.push(file)
  }
  return result
}

function localizableFiles() {
  return [
    ...sourceFiles(rendererRoot),
    ...sourceFiles(path.join(root, 'src', 'electron')),
    ...sourceFiles(path.join(root, 'src', 'shared')),
  ].filter((file) => !file.startsWith(sharedI18nRoot))
}

// --- AST helpers -------------------------------------------------------------------
function hasChinese(value) {
  return /[㐀-鿿，；。：！？、（）【】「」《》]/u.test(value)
}

function normalizedJsxText(value) {
  return value.replace(/\s+/g, ' ').trim()
}

function templateMessage(node) {
  let message = node.head.text
  node.templateSpans.forEach((span, index) => {
    message += `{value${index}}${span.literal.text}`
  })
  return message
}

function isTCall(node) {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't'
}

function isNonLocalizableSkillAsset(node, file) {
  if (!file.endsWith(path.join('storage', 'default-skills.ts'))) return false
  const assignment = node.parent
  if (!ts.isPropertyAssignment(assignment) || assignment.name.getText() !== 'content') return false
  const object = assignment.parent
  if (!ts.isObjectLiteralExpression(object)) return false
  const kindProperty = object.properties.find(
    (property) => ts.isPropertyAssignment(property) && property.name.getText() === 'kind',
  )
  return Boolean(
    kindProperty &&
    ts.isPropertyAssignment(kindProperty) &&
    ts.isStringLiteral(kindProperty.initializer) &&
    kindProperty.initializer.text !== 'markdown',
  )
}

const LOCALIZABLE_SKILL_FIELDS = new Set(['name', 'description', 'systemPrompt', 'content'])

// Collects every message key: the string-literal first argument of each t() call
// (covering conditional/ternary first args), plus DEFAULT_SKILLS name/description/
// systemPrompt and Markdown-content literals. Python/shell skill assets are
// excluded. No CJK heuristic is used: extraction is structural.
function collectKeys(files) {
  const keys = new Set()
  for (const file of files) {
    const sourceText = fs.readFileSync(file, 'utf8')
    const source = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    const collectLiterals = (node, acc) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        acc.push(node.text)
        return
      }
      if (ts.isConditionalExpression(node)) {
        collectLiterals(node.whenTrue, acc)
        collectLiterals(node.whenFalse, acc)
        return
      }
      if (ts.isParenthesizedExpression(node)) {
        collectLiterals(node.expression, acc)
      }
    }
    const visit = (node) => {
      if (isTCall(node) && node.arguments.length > 0) {
        const literals = []
        collectLiterals(node.arguments[0], literals)
        for (const key of literals) keys.add(key)
      }
      if (
        file === defaultSkillsPath &&
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        ts.isPropertyAssignment(node.parent) &&
        LOCALIZABLE_SKILL_FIELDS.has(node.parent.name.getText())
      ) {
        const field = node.parent.name.getText()
        const eligible = field === 'content' ? !isNonLocalizableSkillAsset(node, file) : true
        if (eligible) keys.add(node.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return keys
}

// --- machine translation (en -> zh-CN) ---------------------------------------------
function maskPlaceholders(text) {
  const placeholders = []
  const masked = text.replace(/\{[A-Za-z0-9_]+\}/g, (match) => {
    placeholders.push(match)
    return `__AB_PH_${placeholders.length - 1}__`
  })
  return { masked, placeholders }
}

function restorePlaceholders(translated, placeholders) {
  let result = translated
  for (let index = 0; index < placeholders.length; index += 1) {
    result = result.split(`__AB_PH_${index}__`).join(placeholders[index])
  }
  return result
}

function placeholderSet(text) {
  return JSON.stringify([...new Set(text.match(/\{[A-Za-z0-9_]+\}/g) ?? [])].sort())
}

async function translateBatch(messages) {
  const base = 'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=zh-CN'
  const masked = messages.map((message) => maskPlaceholders(message))
  const query = masked.map((entry) => `q=${encodeURIComponent(entry.masked)}`).join('&')
  let response
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetch(`${base}&${query}`, {
        headers: { 'User-Agent': 'AgentBox localization resource generator' },
      })
      if (response.ok) break
      lastError = new Error(`Translation request failed: ${response.status}`)
    } catch (error) {
      lastError = error
    }
  }
  if (!response?.ok) throw lastError ?? new Error('Translation request failed')
  const translated = await response.json()
  if (!Array.isArray(translated) || translated.length !== messages.length) {
    throw new Error(`Translation response count mismatch (${messages.length})`)
  }
  return translated.map((value, index) => {
    const raw = Array.isArray(value) ? String(value[0] ?? '') : String(value)
    const restored = restorePlaceholders(raw, masked[index].placeholders)
    if (placeholderSet(restored) !== placeholderSet(messages[index])) {
      process.stderr.write(`Placeholder mismatch for ${JSON.stringify(messages[index].slice(0, 60))}; keeping key\n`)
      return messages[index]
    }
    return restored
  })
}

async function translateMessages(messages) {
  const translations = new Map()
  let batch = []
  let encodedLength = 0
  const flush = async () => {
    if (batch.length === 0) return
    const translated = await translateBatch(batch)
    batch.forEach((message, index) => translations.set(message, translated[index] || message))
    batch = []
    encodedLength = 0
  }
  for (const message of messages) {
    const nextLength = encodeURIComponent(message).length + 3
    if (batch.length >= 40 || encodedLength + nextLength > 5_500) await flush()
    batch.push(message)
    encodedLength += nextLength
  }
  await flush()
  return translations
}

// --- canonical Chinese term guard for MT output ------------------------------------
function normalizeZhByContext(key, value) {
  let normalized = value
  if (/\bprovider\b/i.test(key)) normalized = normalized.replace(/供应商/g, '服务商')
  if (/\bweb search\b/i.test(key)) normalized = normalized.replace(/网络搜索|互联网搜索/g, '网页搜索')
  if (/\bMCP server\b/i.test(key)) normalized = normalized.replace(/MCP (?:服务器|服务端)/g, 'MCP 服务')
  return normalized
}

// --- bundle IO ---------------------------------------------------------------------
function readExistingResource(file) {
  if (!fs.existsSync(file)) return {}
  const entries = {}
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*("(?:[^"\\]|\\.)*"):\s*("(?:[^"\\]|\\.)*"),\s*$/.exec(line)
    if (match) entries[JSON.parse(match[1])] = JSON.parse(match[2])
  }
  return entries
}

function resourceFile(variableName, header, entries, typed) {
  const lines = Object.entries(entries).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`)
  return `${header}\nexport const ${variableName}${typed ? ': Record<string, string>' : ''} = {\n${lines.join('\n')}\n}${typed ? '' : ' as const'}\n`
}

function orderEntries(entries) {
  const isHatch = (key) => Object.prototype.hasOwnProperty.call(SEMANTIC_KEYS, key)
  return Object.keys(entries).sort((left, right) => {
    const hatchLeft = isHatch(left)
    const hatchRight = isHatch(right)
    if (hatchLeft !== hatchRight) return hatchLeft ? -1 : 1
    return left.localeCompare(right, 'en-US')
  })
}

// --- generate ----------------------------------------------------------------------
async function generateResources(files) {
  const keys = collectKeys(files)
  // Semantic hatch keys are defined entries: always present in the bundle even
  // when a particular one has no call site yet (it stays available on demand).
  for (const hatchKey of Object.keys(SEMANTIC_KEYS)) keys.add(hatchKey)
  const existingZh = readExistingResource(zhPath)
  for (const hatchKey of Object.keys(SEMANTIC_KEYS)) {
    if (existingZh[hatchKey] === undefined && reviewedZh[hatchKey] === undefined) {
      throw new Error(`Semantic hatch key ${JSON.stringify(hatchKey)} needs an explicit reviewed Chinese value`)
    }
  }
  const missingKeys = [...keys].filter((key) => existingZh[key] === undefined && reviewedZh[key] === undefined)
  const translations = missingKeys.length > 0 ? await translateMessages(missingKeys) : new Map()

  const zh = {}
  const warnings = []
  for (const key of keys) {
    if (reviewedZh[key] !== undefined) {
      zh[key] = reviewedZh[key]
    } else if (existingZh[key] !== undefined) {
      zh[key] = existingZh[key]
    } else {
      const mt = translations.get(key)
      if (mt === undefined) {
        zh[key] = key
        warnings.push(key)
      } else {
        zh[key] = normalizeZhByContext(key, mt)
      }
    }
  }

  // en-US.ts carries only the semantic hatch keys; validate each exists in zh.
  const en = {}
  for (const [hatchKey, enValue] of Object.entries(SEMANTIC_KEYS)) {
    if (zh[hatchKey] === undefined)
      throw new Error(`Semantic hatch key ${JSON.stringify(hatchKey)} missing from zh bundle`)
    en[hatchKey] = enValue
  }

  const orderedZh = {}
  for (const key of orderEntries(zh)) orderedZh[key] = zh[key]
  const orderedEn = {}
  for (const key of Object.keys(en).sort((a, b) => a.localeCompare(b, 'en-US'))) orderedEn[key] = en[key]

  fs.mkdirSync(localesDir, { recursive: true })
  fs.writeFileSync(
    zhPath,
    resourceFile(
      'zhCN',
      '/** Simplified Chinese resource bundle. English source copy is the key; values are reviewed Simplified Chinese. */',
      orderedZh,
      false,
    ),
  )
  fs.writeFileSync(
    enPath,
    resourceFile(
      'enUS',
      '/** English resource bundle. Holds only semantic hatch keys whose shared English text must distinguish different Chinese messages. */',
      orderedEn,
      true,
    ),
  )
  process.stdout.write(`Generated ${keys.size} localized messages.\n`)
  if (warnings.length > 0) {
    process.stdout.write(`Untranslated (kept as English key): ${warnings.length}\n`)
    for (const key of warnings) process.stdout.write(`  ${JSON.stringify(key.slice(0, 80))}\n`)
  }
}

// --- check -------------------------------------------------------------------------
function checkSources(files) {
  const zhKeys = new Set(Object.keys(readExistingResource(zhPath)))
  const english = readExistingResource(enPath)
  const failures = []
  const warnings = []

  for (const [key, value] of Object.entries(SEMANTIC_KEYS)) {
    if (!zhKeys.has(key)) failures.push(`semantic hatch key missing from zh-CN: ${JSON.stringify(key)}`)
    if (english[key] !== value) failures.push(`semantic hatch key missing or stale in en-US: ${JSON.stringify(key)}`)
  }
  for (const key of Object.keys(english)) {
    if (!Object.prototype.hasOwnProperty.call(SEMANTIC_KEYS, key)) {
      failures.push(`unexpected non-semantic key in en-US: ${JSON.stringify(key)}`)
    }
  }
  for (const key of collectKeys([defaultSkillsPath])) {
    if (!zhKeys.has(key)) failures.push(`DEFAULT_SKILLS key missing from zh-CN: ${JSON.stringify(key.slice(0, 60))}`)
  }

  for (const file of files) {
    const rel = path.relative(root, file)
    const sourceText = fs.readFileSync(file, 'utf8')
    const source = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    const visit = (node, inTArg) => {
      if (isTCall(node) && node.arguments.length > 0) {
        const first = node.arguments[0]
        const isLiteral =
          ts.isStringLiteral(first) ||
          ts.isNoSubstitutionTemplateLiteral(first) ||
          ts.isConditionalExpression(first) ||
          ts.isParenthesizedExpression(first)
        if (!isLiteral && file !== defaultSkillsPath) {
          warnings.push(`${rel}: t() first arg is not a string literal (key validity cannot be checked statically)`)
        }
        visit(first, true)
        for (let index = 1; index < node.arguments.length; index += 1) visit(node.arguments[index], false)
        return
      }
      if (ts.isConditionalExpression(node)) {
        // The condition is a comparison value, not a message key; only the
        // branches are keys.
        visit(node.condition, false)
        visit(node.whenTrue, inTArg)
        visit(node.whenFalse, inTArg)
        return
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (inTArg) {
          if (!zhKeys.has(node.text)) failures.push(`${rel}: unknown t() key ${JSON.stringify(node.text.slice(0, 60))}`)
        } else if (hasChinese(node.text) && !isNonLocalizableSkillAsset(node, file)) {
          failures.push(`${rel}: Chinese string outside t() — wrap it: ${JSON.stringify(node.text.slice(0, 60))}`)
        }
      } else if (ts.isJsxText(node)) {
        const text = normalizedJsxText(node.text)
        if (text && hasChinese(text) && !inTArg) {
          failures.push(`${rel}: Chinese JSX text outside t() — wrap it: ${JSON.stringify(text.slice(0, 60))}`)
        }
      } else if (ts.isTemplateExpression(node)) {
        const text = templateMessage(node)
        if (hasChinese(text)) {
          if (inTArg) {
            if (!zhKeys.has(text))
              failures.push(`${rel}: unknown t() template key ${JSON.stringify(text.slice(0, 60))}`)
          } else {
            failures.push(`${rel}: Chinese template outside t() — wrap it`)
          }
        }
      }
      for (const child of node.getChildren(source)) visit(child, inTArg)
    }
    visit(source, false)
  }

  if (failures.length > 0) {
    process.stderr.write(`i18n check failed (${failures.length} issue(s)):\n`)
    for (const failure of failures) process.stderr.write(`  ${failure}\n`)
  }
  for (const warning of warnings) process.stdout.write(`warning: ${warning}\n`)
  process.stdout.write(`i18n check ${failures.length === 0 ? 'passed' : 'failed'}.\n`)
  return failures.length === 0
}

// --- dispatch ----------------------------------------------------------------------
const files = localizableFiles()
if (command === 'generate') {
  await generateResources(files)
} else if (command === 'check') {
  const ok = checkSources(files)
  process.exit(ok ? 0 : 1)
} else {
  throw new Error('Usage: node scripts/localize-renderer.mjs <generate|check>')
}
