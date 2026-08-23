import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const rendererRoot = path.join(root, 'src', 'renderer', 'src')
const sharedI18nRoot = path.join(root, 'src', 'shared', 'i18n')
const command = process.argv[2]

const manualZh = {
  'language.displayName': '简体中文',
  'language.settingLabel': '显示语言',
  'language.settingHint': '更改 AgentBox 界面和系统对话框的语言',
  'code.noOutput': '(代码执行完成，无输出)',
  'code.outputTruncated': '[输出已截断]',
  'code.moduleNotAllowed': '模块 {name} 不在允许列表中',
  'code.dunderNotAllowed': '不允许访问双下划线属性',
  'code.nameNotAllowed': '不允许使用 {name}',
}
const manualEn = {
  'language.displayName': 'English',
  'language.settingLabel': 'Display language',
  'language.settingHint': 'Change the language used by AgentBox and system dialogs',
  'code.noOutput': '(Code execution completed with no output)',
  'code.outputTruncated': '[Output truncated]',
  'code.moduleNotAllowed': 'Module {name} is not allowed',
  'code.dunderNotAllowed': 'Double-underscore attributes are not allowed',
  'code.nameNotAllowed': '{name} is not allowed',
}
const reviewedEn = {
  '安全': 'Secure', '保存服务': 'Save service', '保存技能': 'Save skill', '备份模式': 'Backup mode',
  '本次裁剪并发送': 'Trim and send this time', '本地': 'Local', '本机兼容代理': 'Local compatible proxy',
  '编辑': 'Edit', '编辑技能': 'Edit skill', '编写代码': 'Write code', '次': ' times',
  '代理地址': 'Proxy address', '当前会话目录': 'Current conversation directory', '当前模型': 'Current model',
  '导入技能': 'Import skill', '服务商': 'Provider', '复制': 'Copy', '高': 'High',
  '个服务商': ' providers', '个工具': ' tools', '个会话': ' conversations', '个技能': ' skills',
  '个模型': ' models', '个文件)': ' files)', '个人资料': 'Profile', '关闭': 'Off',
  '关闭头像裁剪': 'Close avatar cropper', '关于': 'About', '会话历史': 'Conversation history',
  '会话数据库': 'Conversation database', '获取': 'Fetch', '极简': 'Minimal', '继续': 'Continue',
  '接着来': 'Continue', '接着做': 'Continue', '价格优先': 'Prefer lower price', '禁止': 'Deny',
  '拒绝': 'Deny', '开发运行时': 'Developer runtimes', '连接异常': 'Connection error', '轮': ' turns',
  '每次确认': 'Always ask', '名称': 'Name', '命令:': 'Command:', '默认': 'Default', '浅': 'shallow ',
  '浅色': 'Light', '深': 'deep ', '输入': 'Input', '搜索': 'Search', '添加': 'Add',
  '停止生成': 'Stop generating', '通用': 'General', '推荐': 'Recommended', '未命名模型': 'Unnamed model',
  '未知模型': 'Unknown model', '系统': 'System', '系统提示词': 'System prompt', '下一个回答': 'Next answer',
  '显示': 'Show', '限流': 'Rate limited', '项': ' items', '新对话': 'New conversation', '新建技能': 'New skill',
  '新建自定义技能': 'New custom skill', '新模型': 'New model', '一起构思': 'Brainstorm',
  '已保护': 'Protected', '已保留中断现场': 'Interrupted state preserved', '已配置': 'Configured',
  '已思考': 'Reasoned', '已推理': 'Reasoned for ', '知道了': 'Got it', '中': 'Medium', '主题': 'Theme',
  '自定义': 'Custom', '自动': 'Auto', '自动裁剪': 'Automatic trimming', '自动搜索': 'Auto search', '作者': 'Author',
  '个人资料': 'Profile', '设置': 'Settings', '思考不可用': 'Reasoning unavailable', '思考关闭': 'Reasoning off',
  '思考模式': 'Reasoning', '新会话默认思考': 'Default reasoning for new conversations',
  '新模型思考强度': 'Default reasoning effort for new models', '支持思考模式': 'Supports reasoning',
  '联网不可用': 'Web search unavailable', '联网关闭': 'Web search off', '原生优先': 'Prefer native',
  '允许回退': 'Allow fallback', '允许供应商回退': 'Allow provider fallback', '智能确认': 'Smart approval',
  '自动匹配': 'Auto match', '自动选择': 'Auto-select', '系统内置': 'Built-in', '浅备份': 'Shallow backup',
  '深备份': 'Deep backup', '收起': 'Collapse',
  '你是一个标题生成助手。根据用户的消息，生成一个简短的对话标题（不超过 12 个汉字）。':
    'You generate concise conversation titles from user messages. Keep each title under 12 words.',
}

function sourceFiles(directory) {
  const result = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...sourceFiles(file))
    else if (/\.tsx?$/i.test(entry.name)) result.push(file)
  }
  return result
}

function runtimeSourceFiles() {
  const excluded = new Set([
    path.join(root, 'src', 'electron', 'storage', 'default-skills.ts'),
  ])
  return [
    ...sourceFiles(path.join(root, 'src', 'electron')),
    ...sourceFiles(path.join(root, 'src', 'shared')),
  ].filter((file) => !excluded.has(file) && !file.startsWith(sharedI18nRoot))
}

function hasChinese(value) {
  return /[\u3400-\u9fff]/u.test(value)
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

function isTranslationArgument(node) {
  return ts.isCallExpression(node.parent)
    && node.parent.arguments[0] === node
    && ts.isIdentifier(node.parent.expression)
    && node.parent.expression.text === 't'
}

function collectMessages(files) {
  const messages = new Set()
  for (const file of files) {
    const sourceText = fs.readFileSync(file, 'utf8')
    const source = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    const visit = (node) => {
      if (ts.isJsxText(node)) {
        const value = normalizedJsxText(node.text)
        if (value && hasChinese(value)) messages.add(value)
      } else if (ts.isTemplateExpression(node)) {
        const value = templateMessage(node)
        if (hasChinese(value)) messages.add(value)
      } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (hasChinese(node.text)) messages.add(node.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return [...messages].sort((left, right) => left.localeCompare(right, 'zh-CN'))
}

async function translateBatch(messages) {
  const base = 'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=zh-CN&tl=en'
  const protectedMessages = messages.map((message) => (
    message.replace(/\{value(\d+)\}/g, '__AB_VALUE_$1__')
  ))
  const query = protectedMessages.map((message) => `q=${encodeURIComponent(message)}`).join('&')
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
  return translated.map((value) => (
    (Array.isArray(value) ? String(value[0] ?? '') : String(value))
      .replace(/__AB_VALUE_(\d+)__/g, '{value$1}')
  ))
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

function resourceFile(variableName, header, entries, typed = false) {
  const lines = Object.entries(entries)
    .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`)
  return `${header}\nexport const ${variableName}${typed ? ': Record<string, string>' : ''} = {\n${lines.join('\n')}\n}${typed ? '' : ' as const'}\n`
}

function readExistingResource(file) {
  if (!fs.existsSync(file)) return {}
  const entries = {}
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*("(?:[^"\\]|\\.)*"):\s*("(?:[^"\\]|\\.)*"),\s*$/.exec(line)
    if (match) entries[JSON.parse(match[1])] = JSON.parse(match[2])
  }
  return entries
}

async function generateResources(files) {
  const messages = collectMessages(files)
  const existingEn = readExistingResource(path.join(sharedI18nRoot, 'locales', 'en-US.ts'))
  const missingMessages = messages.filter((message) => existingEn[message] === undefined)
  const translations = await translateMessages(missingMessages)
  const zh = { ...manualZh }
  const en = { ...manualEn }
  for (const message of messages) {
    zh[message] = message
    en[message] = existingEn[message] ?? translations.get(message) ?? message
  }
  for (const [key, value] of Object.entries(reviewedEn)) {
    if (zh[key] !== undefined) en[key] = value
  }
  fs.mkdirSync(path.join(sharedI18nRoot, 'locales'), { recursive: true })
  fs.writeFileSync(
    path.join(sharedI18nRoot, 'locales', 'zh-CN.ts'),
    resourceFile('zhCN', '/** Simplified Chinese resource bundle. Keys are stable source-message IDs. */', zh),
  )
  fs.writeFileSync(
    path.join(sharedI18nRoot, 'locales', 'en-US.ts'),
    resourceFile('enUS', '/** English resource bundle. It must contain every key defined by zh-CN. */', en, true),
  )
  process.stdout.write(`Generated ${messages.length} localized messages.\n`)
}

function i18nImportPath(file) {
  let relative = path.relative(path.dirname(file), sharedI18nRoot).replaceAll(path.sep, '/')
  if (!relative.startsWith('.')) relative = `./${relative}`
  return relative
}

function transformFile(file) {
  const sourceText = fs.readFileSync(file, 'utf8')
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const replacements = []
  let requiresImport = false

  const visit = (node) => {
    if (ts.isTemplateExpression(node)) {
      const value = templateMessage(node)
      if (hasChinese(value)) {
        const properties = node.templateSpans.map((span, index) => (
          `value${index}: ${span.expression.getText(source)}`
        ))
        replacements.push({
          start: node.getStart(source),
          end: node.end,
          text: `t(${JSON.stringify(value)}, { ${properties.join(', ')} })`,
        })
        requiresImport = true
        return
      }
    } else if (ts.isJsxText(node)) {
      const value = normalizedJsxText(node.text)
      if (value && hasChinese(value)) {
        replacements.push({ start: node.pos, end: node.end, text: `{t(${JSON.stringify(value)})}` })
        requiresImport = true
        return
      }
    } else if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      && hasChinese(node.text)
      && !isTranslationArgument(node)
    ) {
      const replacement = `t(${JSON.stringify(node.text)})`
      if (ts.isJsxAttribute(node.parent) && node.parent.initializer === node) {
        replacements.push({ start: node.getStart(source), end: node.end, text: `{${replacement}}` })
      } else {
        replacements.push({ start: node.getStart(source), end: node.end, text: replacement })
      }
      requiresImport = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)

  if (replacements.length === 0) return false
  const alreadyImportsT = source.statements.some((statement) => (
    ts.isImportDeclaration(statement)
    && ts.isStringLiteral(statement.moduleSpecifier)
    && /(?:shared\/i18n|\.\/i18n)$/.test(statement.moduleSpecifier.text)
    && statement.importClause?.namedBindings
    && ts.isNamedImports(statement.importClause.namedBindings)
    && statement.importClause.namedBindings.elements.some((element) => element.name.text === 't')
  ))
  if (requiresImport && !alreadyImportsT) {
    const imports = source.statements.filter(ts.isImportDeclaration)
    const insertion = imports.at(-1)?.end ?? 0
    replacements.push({
      start: insertion,
      end: insertion,
      text: `\nimport { t } from ${JSON.stringify(i18nImportPath(file))}\n`,
    })
  }

  let next = sourceText
  replacements.sort((left, right) => right.start - left.start)
  for (const replacement of replacements) {
    next = next.slice(0, replacement.start) + replacement.text + next.slice(replacement.end)
  }
  fs.writeFileSync(file, next)
  return true
}

function transformSources(files) {
  let changed = 0
  for (const file of files) if (transformFile(file)) changed += 1
  process.stdout.write(`Localized ${changed} source files.\n`)
}

const rendererFiles = sourceFiles(rendererRoot)
const runtimeFiles = runtimeSourceFiles()
const resourceDefinitionFiles = [
  path.join(root, 'src', 'electron', 'storage', 'default-skills.ts'),
]
if (command === 'generate') {
  await generateResources([...rendererFiles, ...runtimeFiles, ...resourceDefinitionFiles])
}
else if (command === 'transform') transformSources(rendererFiles)
else if (command === 'transform-runtime') transformSources(runtimeFiles)
else throw new Error('Usage: node scripts/localize-renderer.mjs <generate|transform|transform-runtime>')
