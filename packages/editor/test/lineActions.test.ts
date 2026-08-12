import { describe, expect, it } from 'vitest'

import { editActionForCommand, type EditorEditActionCommandId } from '../src/editor/editActions'
import type { ResolvedSelection } from '../src/selections'

/** A resolved selection over [start, end); collapsed when they match. */
function selection(start: number, end = start): ResolvedSelection {
  return {
    anchorOffset: start,
    collapsed: start === end,
    endOffset: end,
    headOffset: end,
    id: `sel:${start}:${end}`,
    reversed: false,
    startOffset: start,
  } as ResolvedSelection
}

/** Applies an action's edits to `text`, so tests assert the resulting document, not edit shapes. */
function run(command: EditorEditActionCommandId, text: string, selections: ResolvedSelection[]) {
  const action = editActionForCommand(command, text, selections)
  let out = text
  for (const edit of [...action.edits].sort((left, right) => right.from - left.from)) {
    out = out.slice(0, edit.from) + edit.text + out.slice(edit.to)
  }

  return out
}

describe('trimTrailingWhitespace', () => {
  it('trims spaces and tabs at line ends across the document', () => {
    expect(run('editor.action.trimTrailingWhitespace', 'a  \nb\t\nc', [selection(0)])).toBe('a\nb\nc')
  })

  it('leaves indentation and clean lines alone', () => {
    expect(run('editor.action.trimTrailingWhitespace', '  a\n  b', [selection(0)])).toBe('  a\n  b')
  })

  it('empties a whitespace-only line', () => {
    expect(run('editor.action.trimTrailingWhitespace', 'a\n   \nb', [selection(0)])).toBe('a\n\nb')
  })
})

describe('sortLines', () => {
  it('sorts the selected lines ascending', () => {
    expect(run('editor.action.sortLinesAscending', 'c\na\nb', [selection(0, 5)])).toBe('a\nb\nc')
  })

  it('sorts descending', () => {
    expect(run('editor.action.sortLinesDescending', 'a\nc\nb', [selection(0, 5)])).toBe('c\nb\na')
  })

  // Reordering a file the user did not select is worse than doing nothing.
  it('does nothing for a single-line selection', () => {
    expect(run('editor.action.sortLinesAscending', 'c\na\nb', [selection(0)])).toBe('c\na\nb')
  })
})

describe('joinLines', () => {
  it('joins the next line with a single space and drops its indentation', () => {
    expect(run('editor.action.joinLines', 'a\n    b', [selection(0)])).toBe('a b')
  })

  it('joins every line of a multi-line selection', () => {
    // 0..5 covers all three rows; 0..3 would stop at the newline ending row 1.
    expect(run('editor.action.joinLines', 'a\nb\nc', [selection(0, 5)])).toBe('a b c')
  })

  it('meets directly when the joined line is blank', () => {
    expect(run('editor.action.joinLines', 'a\n   ', [selection(0)])).toBe('a')
  })

  it('does nothing on the last line', () => {
    expect(run('editor.action.joinLines', 'a', [selection(0)])).toBe('a')
  })
})

describe('duplicateSelection', () => {
  it('duplicates selected text right after it', () => {
    expect(run('editor.action.duplicateSelection', 'abc', [selection(0, 2)])).toBe('ababc')
  })

  it('duplicates the whole line for a collapsed caret', () => {
    expect(run('editor.action.duplicateSelection', 'a\nb', [selection(0)])).toBe('a\na\nb')
  })

  it('duplicates a final line that has no newline', () => {
    expect(run('editor.action.duplicateSelection', 'only', [selection(1)])).toBe('only\nonly')
  })
})

describe('case transforms', () => {
  it('uppercases and lowercases a selection', () => {
    expect(run('editor.action.transformToUppercase', 'aBc', [selection(0, 3)])).toBe('ABC')
    expect(run('editor.action.transformToLowercase', 'aBc', [selection(0, 3)])).toBe('abc')
  })

  it('title-cases each word', () => {
    expect(run('editor.action.transformToTitlecase', 'hello wide world', [selection(0, 16)])).toBe(
      'Hello Wide World',
    )
  })

  it('keeps an apostrophe inside a word', () => {
    expect(run('editor.action.transformToTitlecase', "it's fine", [selection(0, 9)])).toBe(
      "It's Fine",
    )
  })

  // Which range would it even transform? Guessing between selection and word is worse than nothing.
  it('does nothing without a selection', () => {
    expect(run('editor.action.transformToUppercase', 'abc', [selection(1)])).toBe('abc')
  })
})
