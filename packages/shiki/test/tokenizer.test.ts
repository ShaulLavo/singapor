import { afterEach, describe, expect, it } from 'vitest'

import { createIncrementalTokenizer } from '../src'

function flattenTokens(line: readonly { content: string }[]): string {
  return line.map((token) => token.content).join('')
}

const disposables: Array<{ dispose: () => void }> = []

afterEach(() => {
  while (disposables.length > 0)
    disposables.pop()?.dispose()
})

describe('IncrementalShikiTokenizer', () => {
  it('creates token snapshots for the initial document', async () => {
    const tokenizer = await createIncrementalTokenizer({
      lang: 'typescript',
      theme: 'github-dark',
      code: 'const answer = 42',
    })

    disposables.push(tokenizer)

    const snapshot = tokenizer.getSnapshot()
    expect(snapshot.lines).toHaveLength(1)
    expect(flattenTokens(snapshot.lines[0]?.tokens ?? [])).toBe('const answer = 42')
  })

  it('takes the append fast-path when new code extends the current document', async () => {
    const tokenizer = await createIncrementalTokenizer({
      lang: 'typescript',
      theme: 'github-dark',
      code: 'const a',
    })

    disposables.push(tokenizer)

    const patch = tokenizer.update('const a = 1\nconst b = 2')

    expect(patch.fromLine).toBe(0)
    expect(patch.toLine).toBe(1)
    expect(patch.lines.map((line) => line.text)).toEqual(['const a = 1', 'const b = 2'])
    expect(tokenizer.getSnapshot().lines.map((line) => line.text)).toEqual(['const a = 1', 'const b = 2'])
  })

  it('retokenizes changed lines until grammar state stabilizes', async () => {
    const tokenizer = await createIncrementalTokenizer({
      lang: 'typescript',
      theme: 'github-dark',
      code: [
        'const a = 1',
        '/* open',
        'still comment */',
        'const b = 2',
      ].join('\n'),
    })

    disposables.push(tokenizer)

    const patch = tokenizer.update([
      'const a = 1',
      '// open',
      'still comment */',
      'const b = 2',
    ].join('\n'))

    expect(patch.fromLine).toBe(1)
    expect(patch.toLine).toBe(3)
    expect(patch.lines.map((line) => line.text)).toEqual(['// open', 'still comment */'])
    expect(tokenizer.getSnapshot().lines[3]?.text).toBe('const b = 2')
  })

  it('applyEdit inserts text in the middle of a line', async () => {
    //                   0123456789...
    const code = 'const a = 1\nconst b = 2'
    const tokenizer = await createIncrementalTokenizer({
      lang: 'typescript',
      theme: 'github-dark',
      code,
    })

    disposables.push(tokenizer)

    // Insert "nswer" after "a" on line 0  →  "const answer = 1"
    const patch = tokenizer.applyEdit(6, 7, 'answer')

    expect(patch.fromLine).toBe(0)
    expect(patch.lines[0]?.text).toBe('const answer = 1')
    expect(tokenizer.getSnapshot().lines.map((l) => l.text)).toEqual([
      'const answer = 1',
      'const b = 2',
    ])
  })

  it('applyEdit replaces text across multiple lines', async () => {
    const code = 'line 0\nline 1\nline 2\nline 3'
    const tokenizer = await createIncrementalTokenizer({
      lang: 'typescript',
      theme: 'github-dark',
      code,
    })

    disposables.push(tokenizer)

    // Replace "1\nline 2" with "replaced"
    //   "line 0\nline " = 12 chars  →  from = 12
    //   "1\nline 2" = 8 chars       →  to = 12 + 8 = 20
    const patch = tokenizer.applyEdit(12, 20, 'replaced')

    expect(patch.fromLine).toBe(1)
    expect(tokenizer.getSnapshot().lines.map((l) => l.text)).toEqual([
      'line 0',
      'line replaced',
      'line 3',
    ])
  })

  it('applyEdit deletes a range', async () => {
    const code = 'abc\ndef\nghi'
    const tokenizer = await createIncrementalTokenizer({
      lang: 'typescript',
      theme: 'github-dark',
      code,
    })

    disposables.push(tokenizer)

    // Delete "c\ndef\ng" (7 chars starting at 2) → "abhi"
    const patch = tokenizer.applyEdit(2, 9, '')

    expect(tokenizer.getCode()).toBe('abhi')
    expect(patch.fromLine).toBe(0)
    expect(tokenizer.getSnapshot().lines.map((l) => l.text)).toEqual(['abhi'])
  })

  it('applyEdit inserts a newline', async () => {
    const code = 'const a = 1'
    const tokenizer = await createIncrementalTokenizer({
      lang: 'typescript',
      theme: 'github-dark',
      code,
    })

    disposables.push(tokenizer)

    // Insert newline after "const a = 1" → two lines
    const patch = tokenizer.applyEdit(11, 11, '\nconst b = 2')

    expect(tokenizer.getCode()).toBe('const a = 1\nconst b = 2')
    expect(patch.fromLine).toBe(0)
    expect(tokenizer.getSnapshot().lines.map((l) => l.text)).toEqual([
      'const a = 1',
      'const b = 2',
    ])
  })

  it('applyEdit retokenizes suffix lines when grammar state changes', async () => {
    const code = [
      'const a = 1',
      '// comment',
      'const b = 2',
    ].join('\n')

    const tokenizer = await createIncrementalTokenizer({
      lang: 'typescript',
      theme: 'github-dark',
      code,
    })

    disposables.push(tokenizer)

    // Replace "// comment" with "/* comment" → opens a block comment
    // "const a = 1\n" = 12 chars, "// comment" starts at 12, ends at 22
    const patch = tokenizer.applyEdit(12, 22, '/* comment')

    expect(tokenizer.getSnapshot().lines.map((l) => l.text)).toEqual([
      'const a = 1',
      '/* comment',
      'const b = 2',
    ])
    // The patch must include line 2 because the grammar state changed
    expect(patch.fromLine).toBe(1)
    expect(patch.toLine).toBeGreaterThanOrEqual(3)
  })

  it('returns an empty patch when the document does not change', async () => {
    const tokenizer = await createIncrementalTokenizer({
      lang: 'typescript',
      theme: 'github-dark',
      code: 'const answer = 42',
    })

    disposables.push(tokenizer)

    const patch = tokenizer.update('const answer = 42')

    expect(patch).toEqual({ fromLine: 0, toLine: 0, lines: [] })
  })
})
