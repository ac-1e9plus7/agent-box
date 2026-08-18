import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { preprocessMarkdown } from '../src/renderer/src/markdown-helper'

describe('preprocessMarkdown pure function', () => {
  it('returns empty string for empty or falsy inputs', () => {
    expect(preprocessMarkdown('')).toBe('')
  })

  it('preserves plain text without math', () => {
    const input = 'Hello, world! This is a simple test.'
    expect(preprocessMarkdown(input)).toBe(input)
  })

  it('converts display brackets \\[ ... \\] to $$ ... $$', () => {
    const input = 'Here is display math: \\[\\frac{a}{b} = c\\]'
    const result = preprocessMarkdown(input)
    expect(result).toContain('$$\n\\frac{a}{b} = c\n$$')
  })

  it('converts multi-line display brackets \\[ ... \\] to $$ ... $$', () => {
    const input = 'Equation:\n\\[\nE = mc^2\n\\]'
    const result = preprocessMarkdown(input)
    expect(result).toContain('$$\nE = mc^2\n$$')
  })

  it('converts inline parens \\( ... \\) to $ ... $', () => {
    const input = 'Given \\(x > 0\\) and \\(y < 0\\), we have \\(\\sqrt{x}\\).'
    const result = preprocessMarkdown(input)
    expect(result).toBe('Given $x > 0$ and $y < 0$, we have $\\sqrt{x}$.')
  })

  it('wraps standalone LaTeX environments in $$ ... $$', () => {
    const input = 'Matrix:\n\\begin{pmatrix}\n1 & 0 \\\\\n0 & 1\n\\end{pmatrix}'
    const result = preprocessMarkdown(input)
    expect(result).toContain('$$\n\\begin{pmatrix}\n1 & 0 \\\\\n0 & 1\n\\end{pmatrix}\n$$')
  })

  it('wraps aligned and cases environments in $$ ... $$', () => {
    const alignedInput = '\\begin{aligned}\nx &= 1 + 2 \\\\\n  &= 3\n\\end{aligned}'
    expect(preprocessMarkdown(alignedInput)).toContain('$$\n\\begin{aligned}')

    const casesInput = 'f(x) = \\begin{cases}\n0 & x < 0 \\\\\n1 & x \\ge 0\n\\end{cases}'
    expect(preprocessMarkdown(casesInput)).toContain('$$\n\\begin{cases}')
  })

  it('does not double-wrap environments already inside $$', () => {
    const input = '$$\\begin{matrix}\na & b\n\\end{matrix}$$'
    const result = preprocessMarkdown(input)
    expect(result).not.toContain('$$$$')
    expect(result).toContain('$$\n\\begin{matrix}')
  })

  it('converts math code fence to $$ ... $$', () => {
    const input = '```math\n\\int_0^1 x^2 dx\n```'
    const result = preprocessMarkdown(input)
    expect(result).toContain('$$\n\\int_0^1 x^2 dx\n$$')
  })

  it('does not modify non-math code blocks', () => {
    const input = '```typescript\nconst formula = "\\[1, 2, 3\\]";\nconst cost = "$100";\n```'
    const result = preprocessMarkdown(input)
    expect(result).toBe(input)
  })

  it('does not modify inline code spans', () => {
    const input = 'Use `\\[a-z\\]` and `\\(x\\)` and `$100` for regex.'
    const result = preprocessMarkdown(input)
    expect(result).toBe(input)
  })

  it('protects standalone currency amounts from being misparsed as math', () => {
    const input = 'Prices are $10, $20.50, and $1,000 for tickets.'
    const result = preprocessMarkdown(input)
    expect(result).toBe('Prices are \\$10, \\$20.50, and \\$1,000 for tickets.')
  })

  it('normalizes $$...$$ delimiters', () => {
    const input = '$$E = mc^2$$'
    const result = preprocessMarkdown(input)
    expect(result).toBe('\n$$\nE = mc^2\n$$\n')
  })
})

describe('Markdown rendering with LaTeX and line breaks integration', () => {
  function render(markdown: string): string {
    const processed = preprocessMarkdown(markdown)
    return renderToString(
      React.createElement(
        ReactMarkdown,
        {
          rehypePlugins: [[rehypeKatex, { throwOnError: false, strict: false }]],
          remarkPlugins: [remarkGfm, remarkBreaks, remarkMath]
        },
        processed
      )
    )
  }

  it('renders single newlines as line breaks (<br>)', () => {
    const input = 'Line 1\nLine 2'
    const html = render(input)
    expect(html).toContain('<br')
    expect(html).toContain('Line 1')
    expect(html).toContain('Line 2')
  })

  it('renders inline LaTeX formulas via $...$', () => {
    const input = 'Energy is $E = mc^2$.'
    const html = render(input)
    expect(html).toContain('katex')
    expect(html).toContain('<math')
    expect(html).toContain('E = mc^2')
  })

  it('renders inline LaTeX formulas via \\(...\\)', () => {
    const input = 'Formula: \\(\\alpha + \\beta = \\gamma\\).'
    const html = render(input)
    expect(html).toContain('katex')
    expect(html).toContain('alpha')
  })

  it('renders display LaTeX formulas via $$...$$', () => {
    const input = '$$\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}$$'
    const html = render(input)
    expect(html).toContain('katex-display')
    expect(html).toContain('katex')
  })

  it('renders display LaTeX formulas via \\[...\\]', () => {
    const input = '\\[\\sum_{i=1}^n i = \\frac{n(n+1)}{2}\\]'
    const html = render(input)
    expect(html).toContain('katex-display')
    expect(html).toContain('katex')
  })

  it('renders matrix environments', () => {
    const input = '\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}'
    const html = render(input)
    expect(html).toContain('katex-display')
    expect(html).toContain('pmatrix')
  })

  it('renders currency correctly without broken math symbols', () => {
    const input = 'Item A is $50 and Item B is $100.'
    const html = render(input)
    expect(html).toContain('$50')
    expect(html).toContain('$100')
    expect(html).not.toContain('katex')
  })

  it('handles invalid/malformed LaTeX without throwing exceptions', () => {
    const input = 'Invalid math: $$\\unknownCommand{123}$$'
    expect(() => render(input)).not.toThrow()
    const html = render(input)
    expect(html).toContain('unknownCommand')
  })
})
