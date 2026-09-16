import fs from 'node:fs'
import path from 'node:path'

const baseline = JSON.parse(fs.readFileSync('tests/coverage-baseline.json', 'utf8'))
const report = JSON.parse(fs.readFileSync('coverage/coverage-summary.json', 'utf8'))
const results = new Map(
  Object.entries(report)
    .filter(([file]) => file !== 'total')
    .map(([file, value]) => [path.relative(process.cwd(), file).replaceAll('\\', '/'), value]),
)
const failures = []
for (const [file, thresholds] of Object.entries(baseline)) {
  for (const [metric, minimum] of Object.entries(thresholds)) {
    const actual = results.get(file)?.[metric]?.pct
    if (typeof actual !== 'number' || actual < minimum)
      failures.push(`${file} ${metric}: ${actual ?? 'missing'} < ${minimum}`)
  }
}
if (failures.length) {
  console.error(failures.join('\n'))
  process.exitCode = 1
} else console.log(`Coverage baseline passed for ${Object.keys(baseline).length} critical modules.`)
