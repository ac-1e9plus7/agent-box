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
