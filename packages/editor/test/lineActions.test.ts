import { describe, expect, it } from 'vitest'

import {
  editActionForCommand,
  isEditorEditActionCommand,
  type EditorEditActionCommandId,
} from '../src/editor/editActions'
import { defaultEditorKeyBindings, editorCommandPackForCommand } from '../src/editor/keymap'
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
    expect(run('editor.action.trimTrailingWhitespace', 'a  \nb\t\nc', [selection(0)])).toBe(
      'a\nb\nc',
    )
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

  it('does nothing without a selection', () => {
    expect(run('editor.action.transformToUppercase', 'abc', [selection(1)])).toBe('abc')
  })
})

describe('deleteWord', () => {
  it('takes the word the caret is against', () => {
    expect(run('deleteWordLeft', 'alpha beta', [selection(10)])).toBe('alpha ')
    expect(run('deleteWordRight', 'alpha beta', [selection(0)])).toBe('beta')
  })

  it('takes the line break when the caret is against a line edge', () => {
    expect(run('deleteWordLeft', 'alpha\nbeta', [selection(6)])).toBe('alphabeta')
    expect(run('deleteWordRight', 'alpha\nbeta', [selection(5)])).toBe('alphabeta')
  })

  it('has nothing to take at the document edges', () => {
    expect(run('deleteWordLeft', 'abc', [selection(0)])).toBe('abc')
    expect(run('deleteWordRight', 'abc', [selection(3)])).toBe('abc')
  })
})

describe('deleteWordPart', () => {
  it('takes one camel hump', () => {
    expect(run('deleteWordPartLeft', 'parseValue', [selection(10)])).toBe('parse')
    expect(run('deleteWordPartRight', 'parseValue', [selection(0)])).toBe('Value')
  })

  it('ends an acronym at the capital that starts the next hump', () => {
    expect(run('deleteWordPartLeft', 'parseHTTPResponse', [selection(17)])).toBe('parseHTTP')
  })

  it('takes one snake_case part where the word delete takes the whole name', () => {
    expect(run('deleteWordPartLeft', 'parse_value next', [selection(11)])).toBe('parse_ next')
    expect(run('deleteWordLeft', 'parse_value next', [selection(11)])).toBe(' next')
  })

  it('stops on the space in front of a word instead of taking the word too', () => {
    expect(run('deleteWordPartLeft', 'alpha beta', [selection(6)])).toBe('alphabeta')
    expect(run('deleteWordPartRight', 'alpha beta', [selection(5)])).toBe('alphabeta')
  })

  it('takes the line break when the caret is against a line edge', () => {
    expect(run('deleteWordPartLeft', 'alpha\nbeta', [selection(6)])).toBe('alphabeta')
    expect(run('deleteWordPartRight', 'alpha\nbeta', [selection(5)])).toBe('alphabeta')
  })

  it('has nothing to take at the document edges', () => {
    expect(run('deleteWordPartLeft', 'abc', [selection(0)])).toBe('abc')
    expect(run('deleteWordPartRight', 'abc', [selection(3)])).toBe('abc')
  })
})

describe('word-part command wiring', () => {
  const wordPartCommands = [
    'cursorWordPartLeft',
    'cursorWordPartRight',
    'cursorWordPartLeftSelect',
    'cursorWordPartRightSelect',
    'deleteWordPartLeft',
    'deleteWordPartRight',
  ] as const

  // A pack is what carries a binding into a layer, so an unclassified command is bound to nothing.
  it.each(wordPartCommands)(
    'gives %s a pack and a default binding on every platform',
    (command) => {
      expect(editorCommandPackForCommand(command)).not.toBeNull()

      for (const platform of ['mac', 'windows', 'linux'] as const) {
        expect(defaultEditorKeyBindings(platform).map((binding) => binding.command)).toContain(
          command,
        )
      }
    },
  )

  it('routes the two deletes to the edit actions', () => {
    expect(isEditorEditActionCommand('deleteWordPartLeft')).toBe(true)
    expect(isEditorEditActionCommand('deleteWordPartRight')).toBe(true)
  })
})
