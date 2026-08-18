/**
 * Preprocesses markdown text before passing to ReactMarkdown.
 *
 * Normalizes LaTeX math syntax:
 * - Converts display math \\[ ... \\] to $$ ... $$
 * - Converts inline math \\( ... \\) to $ ... $
 * - Wraps standalone LaTeX environments (matrix, pmatrix, aligned, cases, etc.) in $$ ... $$
 * - Converts ```math code blocks to $$ ... $$
 * - Protects standalone currency amounts (e.g. $100, $50.99) from being misparsed as math delimiters
 * - Normalizes $$ ... $$ delimiters to ensure block-level parsing
 * - Leaves standard code blocks and inline code spans untouched
 */
export function preprocessMarkdown(content: string): string {
  if (!content) return ''

  // Split into code blocks (fenced ``` or ~~~), inline code spans (`...`), and non-code parts
  const parts = content.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g)

  return parts
    .map((part, index) => {
      // Odd indices are code blocks or inline code spans
      if (index % 2 === 1) {
        // If the code fence is explicitly tagged as math / latex-math, render as display math
        const mathBlockMatch = part.match(/^```(?:math|latex-math)\s*\n([\s\S]*?)\n?```$/i)
        if (mathBlockMatch && mathBlockMatch[1] !== undefined) {
          return `\n$$\n${mathBlockMatch[1].trim()}\n$$\n`
        }
        return part
      }

      let text = part

      // 1. Convert display math \\[ ... \\] to \n$$\n...\n$$\n
      text = text.replace(/\\\[([\s\S]*?)\\\]/g, (_, math: string) => `\n$$\n${math.trim()}\n$$\n`)

      // 2. Convert inline math \\( ... \\) to $...$
      text = text.replace(/\\\(([\s\S]*?)\\\)/g, (_, math: string) => {
        const trimmed = math.trim()
        return trimmed ? `$${trimmed}$` : ''
      })

      // 3. Convert standalone LaTeX environments to $$...$$
      text = text.replace(
        /(?<!\$)\\(begin\{(?:matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|cases|aligned|align\*?|equation\*?|gather\*?|split)\}[\s\S]*?\\end\{(?:matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|cases|aligned|align\*?|equation\*?|gather\*?|split)\})(?!\$)/g,
        (match: string) => `\n$$\n${match.trim()}\n$$\n`
      )

      // 4. Protect standalone currency amounts (e.g. $100, $50.99, $1,000) from accidental pairing
      text = text.replace(
        /(^|[\s(（\[<])\$(\d+(?:[\d,.]*\d)?)(?=$|[\s,.:;!?!)[\]>，。])/g,
        (_match: string, prefix: string, amount: string) => `${prefix}\\$${amount}`
      )

      // 5. Normalize $$...$$ blocks so $$ is separated by newlines
      text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_, math: string) => `\n$$\n${math.trim()}\n$$\n`)

      return text
    })
    .join('')
}
