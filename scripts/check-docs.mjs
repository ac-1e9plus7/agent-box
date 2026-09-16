import fs from 'node:fs'
import path from 'node:path'

const english = fs
  .readdirSync('docs')
  .filter((file) => file.endsWith('.md'))
  .sort()
const chinese = fs
  .readdirSync('docs_zh')
  .filter((file) => file.endsWith('.md'))
  .sort()
const errors = []
if (JSON.stringify(english) !== JSON.stringify(chinese)) errors.push('English/Chinese document filenames differ')
const files = [
  'README.md',
  'README_zh.md',
  'AGENTS.md',
  'CLAUDE.md',
  ...english.map((file) => `docs/${file}`),
  ...chinese.map((file) => `docs_zh/${file}`),
]
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)
  if (lines.some((line) => /[\t ]+$/.test(line))) errors.push(`${file}: trailing whitespace`)
  if (lines.filter((line) => /^\s*```/.test(line)).length % 2) errors.push(`${file}: unbalanced code fences`)
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const link = match[1].replace(/^<|>$/g, '').split('#')[0]
    if (!link || /^[a-z]+:/i.test(link)) continue
    if (!fs.existsSync(path.resolve(path.dirname(file), decodeURIComponent(link))))
      errors.push(`${file}: missing ${link}`)
  }
}
const normalize = (text) => text.replaceAll('CLAUDE.md', 'AGENTS.md').replaceAll('\r\n', '\n')
if (normalize(fs.readFileSync('AGENTS.md', 'utf8')) !== normalize(fs.readFileSync('CLAUDE.md', 'utf8')))
  errors.push('AGENTS.md and CLAUDE.md differ')
if (errors.length) {
  console.error(errors.join('\n'))
  process.exitCode = 1
} else console.log(`Documentation structure and local links passed (${files.length} files).`)
