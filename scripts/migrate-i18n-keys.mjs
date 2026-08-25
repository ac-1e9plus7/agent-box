import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import ts from 'typescript'

// One-shot codemod: flips the i18n key scheme from Chinese-source-text keys to
// English-source-text keys. See docs/i18n.md for the target architecture.
//
//   node scripts/migrate-i18n-keys.mjs            dry-run (report only)
//   node scripts/migrate-i18n-keys.mjs --apply   rewrite sources + bundles
//   node scripts/migrate-i18n-keys.mjs --verify  re-parse new bundles, self-check

const root = process.cwd()
const sharedI18nRoot = path.join(root, 'src', 'shared', 'i18n')
const zhPath = path.join(sharedI18nRoot, 'locales', 'zh-CN.ts')
const enPath = path.join(sharedI18nRoot, 'locales', 'en-US.ts')
const defaultSkillsPath = path.join(root, 'src', 'electron', 'storage', 'default-skills.ts')

const mode = process.argv.includes('--apply') ? 'apply' : process.argv.includes('--verify') ? 'verify' : 'dry-run'

// --- collision resolution table ---------------------------------------------------
// For each COLLISION group (distinct old keys sharing one English value but with
// different Chinese values), one member takes the plain English key; the others
// become "semantic hatch" keys whose en value equals the shared English text and
// whose zh value preserves the original Chinese. MERGE groups (identical zh too)
// need no entry: default inversion collapses them.
// Keys are the exact shared English values (verified against the old bundle).
const RESOLUTION = {
  English: { plain: 'language.englishName', hatches: { 'language.displayName': 'language.displayName' } },
  '[Output truncated]': { plain: 'code.outputTruncated', hatches: { '\n[输出已截断]': 'stream.outputTruncatedLine' } },
  'Export backup': { plain: '导出备份', hatches: { 导出加密备份: 'backup.exportEncrypted' } },
  Continue: {
    plain: '继续',
    hatches: { 接着来: 'agentContinuation.continueVariant1', 接着做: 'agentContinuation.continueVariant2' },
  },
  Deny: { plain: '拒绝', hatches: { 禁止: 'modelPermissions.denyOption' } },
  how: { plain: '如何', hatches: { 怎么: 'skillRetrieval.howVariant' } },
  'Add MCP server': { plain: '添加 MCP 服务', hatches: { '新建 MCP 外部服务': 'mcp.addServerHeading' } },
  'New conversation': { plain: '新建对话', hatches: { 新对话: 'conversation.newPlaceholder' } },
  'Try again': {
    plain: '重试',
    hatches: {
      再次尝试: 'agentContinuation.tryAgainVariant1',
      再试一次: 'agentContinuation.tryAgainVariant2',
      重新尝试: 'agentContinuation.tryAgainVariant3',
    },
  },
  'Agent tool-call limit': {
    plain: 'Agent 工具调用轮次上限',
    hatches: { 'Agent 工具调用轮次': 'agent.toolCallTurns' },
  },
  'CLIProxyAPI (local)': {
    plain: 'CLIProxyAPI（本机）',
    hatches: { 'CLIProxyAPI（本地）': 'provider.cliProxyLocalVariant' },
  },
}

// --- bundle parsing ----------------------------------------------------------------
function parseBundleText(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  let body = text.slice(start + 1, end)
  // strip trailing commas so JSON.parse accepts it
  body = body.replace(/,(\s*\n?\s*)$/s, '$1').replace(/,\s*}/g, '}')
  return JSON.parse('{' + body + '}')
}

function parseBundle(file) {
  return parseBundleText(fs.readFileSync(file, 'utf8'))
}

// --- mapping construction ----------------------------------------------------------
function buildMapping(oldZh, oldEn) {
  // group old keys by english value
  const byEn = {}
  for (const key of Object.keys(oldZh)) {
    const en = oldEn[key]
    if (en === undefined) throw new Error(`Old key has no English value: ${JSON.stringify(key)}`)
    ;(byEn[en] || (byEn[en] = [])).push(key)
  }

  const oldToNew = new Map() // oldKey -> newKey
  const hatchEn = {} // newKey -> english value (en-US.ts entries)
  const collisions = []
  const merges = []

  for (const [enValue, keys] of Object.entries(byEn)) {
    if (keys.length === 1) {
      // default inversion
      oldToNew.set(keys[0], enValue)
      continue
    }
    const distinctZh = [...new Set(keys.map((k) => oldZh[k]))]
    if (distinctZh.length === 1) {
      // MERGE: all collapse to the plain english key
      for (const k of keys) oldToNew.set(k, enValue)
      merges.push({ enValue, keys, zh: distinctZh[0] })
      continue
    }
    // COLLISION: needs resolution
    const resolution = RESOLUTION[enValue]
    if (!resolution) {
      throw new Error(`Unresolved collision group for en value ${JSON.stringify(enValue)}: ${JSON.stringify(keys)}`)
    }
    // validate resolution covers exactly these keys
    const resKeys = new Set([resolution.plain, ...Object.keys(resolution.hatches)])
    for (const k of keys) {
      if (!resKeys.has(k))
        throw new Error(`Resolution for ${JSON.stringify(enValue)} missing old key ${JSON.stringify(k)}`)
    }
    if (resKeys.size !== keys.length) {
      throw new Error(
        `Resolution for ${JSON.stringify(enValue)} has extra keys: ${JSON.stringify([...resKeys].filter((k) => !keys.includes(k)))}`,
      )
    }
    oldToNew.set(resolution.plain, enValue)
    for (const [oldKey, newName] of Object.entries(resolution.hatches)) {
      oldToNew.set(oldKey, newName)
      hatchEn[newName] = enValue
    }
    collisions.push({ enValue, keys, resolution })
  }
  return { oldToNew, hatchEn, collisions, merges }
}

// --- new bundle construction -------------------------------------------------------
function buildBundles(oldZh, oldEn, oldToNew, hatchEn) {
  const newZh = {} // newKey -> chinese value
  const newEn = {} // newKey -> english value (hatch only)
  for (const [oldKey, newKey] of oldToNew) {
    const zhValue = oldZh[oldKey]
    if (Object.prototype.hasOwnProperty.call(newZh, newKey) && newZh[newKey] !== zhValue) {
      throw new Error(`New key collision with differing zh: ${JSON.stringify(newKey)} (old ${JSON.stringify(oldKey)})`)
    }
    newZh[newKey] = zhValue
  }
  for (const [newKey, enValue] of Object.entries(hatchEn)) {
    if (!Object.prototype.hasOwnProperty.call(newZh, newKey)) {
      throw new Error(`Hatch key ${JSON.stringify(newKey)} missing from zh bundle`)
    }
    newEn[newKey] = enValue
  }
  // order: hatch keys first (sorted), then plain keys by localeCompare('en-US')
  const isHatch = (k) => Object.prototype.hasOwnProperty.call(hatchEn, k)
  const sorted = Object.keys(newZh).sort((a, b) => {
    const ha = isHatch(a),
      hb = isHatch(b)
    if (ha !== hb) return ha ? -1 : 1
    return a.localeCompare(b, 'en-US')
  })
  const orderedZh = {}
  for (const k of sorted) orderedZh[k] = newZh[k]
  const orderedEn = {}
  for (const k of sorted.filter(isHatch)) orderedEn[k] = newEn[k]
  return { orderedZh, orderedEn }
}

function resourceFile(variableName, header, entries, typed) {
  const lines = Object.entries(entries).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`)
  return `${header}\nexport const ${variableName}${typed ? ': Record<string, string>' : ''} = {\n${lines.join('\n')}\n}${typed ? '' : ' as const'}\n`
}

// --- AST helpers -------------------------------------------------------------------
function sourceFileOf(file, sourceText) {
  return ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

function isTCall(node) {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't'
}

// Collect string-literal leaf nodes inside the first argument of a t() call.
// Covers direct literals and both branches of a conditional (ternary) first arg.
function collectTLiterals(node, acc) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    acc.push(node)
    return
  }
  if (ts.isConditionalExpression(node)) {
    collectTLiterals(node.whenTrue, acc)
    collectTLiterals(node.whenFalse, acc)
    return
  }
  if (ts.isParenthesizedExpression(node)) {
    collectTLiterals(node.expression, acc)
    return
  }
  // any other shape (identifier, template with expr, etc.) -> no literal to rewrite
}

function rewriteCallSites(files, oldToNew, report) {
  let totalRewrites = 0
  for (const file of files) {
    const sourceText = fs.readFileSync(file, 'utf8')
    const source = sourceFileOf(file, sourceText)
    const replacements = []
    const unmapped = []

    const visit = (node) => {
      if (isTCall(node) && node.arguments.length > 0) {
        const literals = []
        collectTLiterals(node.arguments[0], literals)
        for (const lit of literals) {
          const oldKey = lit.text
          if (oldToNew.has(oldKey)) {
            const newKey = oldToNew.get(oldKey)
            replacements.push({
              start: lit.getStart(source),
              end: lit.end,
              text: JSON.stringify(newKey),
            })
          } else {
            unmapped.push(oldKey)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)

    if (unmapped.length > 0) {
      report.unmappedLiterals[file] = [...new Set(unmapped)]
    }
    if (replacements.length === 0) continue

    replacements.sort((a, b) => b.start - a.start)
    let next = sourceText
    for (const r of replacements) {
      next = next.slice(0, r.start) + r.text + next.slice(r.end)
    }
    if (mode === 'apply') fs.writeFileSync(file, next)
    report.callSiteRewrites[file] = replacements.length
    totalRewrites += replacements.length
  }
  report.totalCallSiteRewrites = totalRewrites
}

// Rewrite DEFAULT_SKILLS name/description/systemPrompt and markdown-content
// literals from Chinese source to the reviewed English counterpart.
function isMarkdownFileContent(node) {
  // true when this string/template literal is a `content` property of a file
  // object whose `kind` is 'markdown'
  const assignment = node.parent
  if (!ts.isPropertyAssignment(assignment) || assignment.name.getText() !== 'content') return false
  const object = assignment.parent
  if (!ts.isObjectLiteralExpression(object)) return false
  const kindProp = object.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === 'kind')
  return Boolean(
    kindProp &&
    ts.isPropertyAssignment(kindProp) &&
    ts.isStringLiteral(kindProp.initializer) &&
    kindProp.initializer.text === 'markdown',
  )
}

const LOCALIZABLE_SKILL_FIELDS = new Set(['name', 'description', 'systemPrompt', 'content'])

function rewriteDefaultSkills(oldToNew, report) {
  const file = defaultSkillsPath
  const sourceText = fs.readFileSync(file, 'utf8')
  const source = sourceFileOf(file, sourceText)
  const replacements = []
  const counts = { name: 0, description: 0, systemPrompt: 0, content: 0 }

  const visit = (node) => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      ts.isPropertyAssignment(node.parent)
    ) {
      const fieldName = node.parent.name.getText()
      if (LOCALIZABLE_SKILL_FIELDS.has(fieldName)) {
        const isContent = fieldName === 'content'
        const eligible = isContent ? isMarkdownFileContent(node) : true
        if (eligible && oldToNew.has(node.text)) {
          const newKey = oldToNew.get(node.text)
          replacements.push({
            start: node.getStart(source),
            end: node.end,
            text: isContent ? asTemplateLiteral(newKey) : JSON.stringify(newKey),
            field: fieldName,
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)

  for (const r of replacements) counts[r.field] += 1
  if (replacements.length === 0) return
  replacements.sort((a, b) => b.start - a.start)
  let next = sourceText
  for (const r of replacements) {
    next = next.slice(0, r.start) + r.text + next.slice(r.end)
  }
  if (mode === 'apply') fs.writeFileSync(file, next)
  report.defaultSkillsRewrites = counts
}

function asTemplateLiteral(text) {
  // preserve multi-line readability for markdown content; escape special tokens
  return '`' + text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`'
}

// --- file collection ----------------------------------------------------------------
function sourceFiles(directory) {
  const result = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...sourceFiles(file))
    else if (/\.tsx?$/i.test(entry.name)) result.push(file)
  }
  return result
}

function callSiteFiles() {
  const rendererRoot = path.join(root, 'src', 'renderer', 'src')
  const files = [
    ...sourceFiles(rendererRoot),
    ...sourceFiles(path.join(root, 'src', 'electron')),
    ...sourceFiles(path.join(root, 'src', 'shared')),
  ]
  return files.filter((f) => !f.startsWith(sharedI18nRoot) && f !== defaultSkillsPath)
}

// --- main ---------------------------------------------------------------------------
const report = {
  callSiteRewrites: {},
  unmappedLiterals: {},
  totalCallSiteRewrites: 0,
  defaultSkillsRewrites: null,
  collisions: [],
  merges: [],
}

// In verify mode the on-disk bundles are already the NEW (migrated) bundles,
// so the pre-migration state is reconstructed from git HEAD.
function execGit(...args) {
  return execSync(['git', ...args].join(' '), { encoding: 'utf8' })
}

const oldZh =
  mode === 'verify'
    ? parseBundleText(execGit('show', `HEAD:${path.relative(root, zhPath).replaceAll(path.sep, '/')}`))
    : parseBundle(zhPath)
const oldEn =
  mode === 'verify'
    ? parseBundleText(execGit('show', `HEAD:${path.relative(root, enPath).replaceAll(path.sep, '/')}`))
    : parseBundle(enPath)

// idempotency guard: zh-CN keys already English -> already migrated.
// --verify intentionally bypasses this so it can self-check a migrated tree.
const zhKeys = Object.keys(oldZh)
const cjkInZhKeys = zhKeys.filter((k) => /[㐀-鿿]/u.test(k)).length
if (cjkInZhKeys === 0 && mode !== 'verify') {
  process.stderr.write('zh-CN.ts keys contain no CJK — already migrated. Refusing to run.\n')
  process.exit(1)
}

const { oldToNew, hatchEn, collisions, merges } = buildMapping(oldZh, oldEn)
report.collisions = collisions
report.merges = merges

if (mode === 'verify') {
  // re-parse the NEW bundles from disk and re-implement t() to self-check
  const newZh = parseBundle(zhPath)
  const newEn = parseBundle(enPath)
  const t = (lang, key, values) => {
    let template = newZh[key] ?? newEn[key] ?? key
    if (lang === 'en-US') template = newEn[key] ?? key
    if (!values) return template
    return template.replace(/\{([A-Za-z0-9_]+)\}/g, (m, name) =>
      Object.prototype.hasOwnProperty.call(values, name) ? String(values[name] ?? '') : m,
    )
  }
  let failures = 0
  for (const [oldKey, newKey] of oldToNew) {
    const expZh = oldZh[oldKey]
    const expEn = oldEn[oldKey]
    const gotZh = t('zh-CN', newKey)
    const gotEn = t('en-US', newKey)
    if (gotZh !== expZh) {
      failures += 1
      process.stderr.write(
        `zh mismatch ${JSON.stringify(oldKey)} -> ${JSON.stringify(newKey)}: ${JSON.stringify(gotZh)} !== ${JSON.stringify(expZh)}\n`,
      )
    }
    if (gotEn !== expEn) {
      failures += 1
      process.stderr.write(
        `en mismatch ${JSON.stringify(oldKey)} -> ${JSON.stringify(newKey)}: ${JSON.stringify(gotEn)} !== ${JSON.stringify(expEn)}\n`,
      )
    }
  }
  process.stdout.write(`verify: ${oldToNew.size} keys checked, ${failures} failures\n`)
  process.exit(failures === 0 ? 0 : 1)
}

// dry-run / apply: compute everything, then (apply) write
const { orderedZh, orderedEn } = buildBundles(oldZh, oldEn, oldToNew, hatchEn)

const callSiteList = callSiteFiles()
rewriteCallSites(callSiteList, oldToNew, report)
rewriteDefaultSkills(oldToNew, report)

if (mode === 'apply') {
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
}

// --- report -------------------------------------------------------------------------
const unmappedFiles = Object.keys(report.unmappedLiterals)

process.stdout.write(`i18n key migration ${mode === 'apply' ? '(applied)' : '(dry-run)'}\n`)
process.stdout.write(
  `  old keys: ${oldToNew.size} (zh entries: ${Object.keys(orderedZh).length}, en hatch entries: ${Object.keys(orderedEn).length})\n`,
)
process.stdout.write(`  collision groups: ${collisions.length} (resolved via semantic hatch keys)\n`)
process.stdout.write(`  merge groups: ${merges.length} (collapsed to plain keys)\n`)
process.stdout.write(`  call-site files rewritten: ${Object.keys(report.callSiteRewrites).length}\n`)
process.stdout.write(`  call-site literals rewritten: ${report.totalCallSiteRewrites}\n`)
if (report.defaultSkillsRewrites) {
  const c = report.defaultSkillsRewrites
  process.stdout.write(
    `  DEFAULT_SKILLS rewrites: names ${c.name}, descriptions ${c.description}, systemPrompt ${c.systemPrompt}, markdown content ${c.content}\n`,
  )
}
if (unmappedFiles.length > 0) {
  process.stdout.write(`  UNMAPPED literals inside t() args (must be empty):\n`)
  for (const [f, keys] of Object.entries(report.unmappedLiterals)) {
    process.stdout.write(`    ${path.relative(root, f)}: ${JSON.stringify(keys)}\n`)
  }
}
process.stdout.write(`\ncollision resolutions:\n`)
for (const c of collisions) {
  const parts = c.keys.map((k) => {
    const nk = oldToNew.get(k)
    return nk === c.enValue
      ? `${JSON.stringify(k)} -> plain ${JSON.stringify(nk)}`
      : `${JSON.stringify(k)} -> ${JSON.stringify(nk)}`
  })
  process.stdout.write(`  ${JSON.stringify(c.enValue)}: ${parts.join('; ')}\n`)
}
process.stdout.write(`\nmerge resolutions:\n`)
for (const m of merges) {
  process.stdout.write(
    `  ${JSON.stringify(m.enValue)}: ${JSON.stringify(m.keys)} -> plain ${JSON.stringify(m.enValue)} (zh ${JSON.stringify(m.zh)})\n`,
  )
}

if (unmappedFiles.length > 0) {
  process.exit(1)
}
