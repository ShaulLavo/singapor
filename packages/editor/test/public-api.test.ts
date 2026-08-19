import { describe, expect, it } from 'vitest'

import * as core from '@singapor/core'
import {
  characterClassAt,
  createPieceTableSnapshot,
  materializePieceTableFullText,
  nextWordOffset,
  previousWordOffset,
  readPieceTableTextRange,
  wordRangeAtOffset,
  type TextCharacterClass,
  type TextEdit,
  type TextOffsetRange,
} from '@singapor/core/document'
import { Editor } from '@singapor/core/editor'
import {
  createEditorCapabilityToken,
  createEditorLanguageFeatureToken,
  EDITOR_FIND_FEATURE,
  EDITOR_FIND_FEATURE_ID,
  type EditorAutoClosingPair,
  type EditorBlockCommentTokens,
  type EditorBracketPair,
  type EditorCommentTokens,
  type EditorDecoration,
  EditorDecorationStore,
  type EditorDecorationRange,
  type EditorDecorationSpec,
  type EditorDecorationSurface,
  type EditorEditContributionContext,
  type EditorEnterAction,
  type EditorFindFeature,
  type EditorFoldingRules,
  type EditorIndentationRules,
  type EditorLanguageConfiguration,
  type EditorLanguageFeatureSelector,
  type EditorLanguageFeatureToken,
  editorLanguageConfiguration,
  type EditorOnEnterRule,
  EDITOR_MINIMAP_FEATURE,
  EDITOR_MINIMAP_FEATURE_ID,
  type EditorPluginContext,
  type EditorReindentOptions,
  type EditorSnippetMirror,
  type EditorSnippetStop,
  type EditorTrackedRanges,
  type EditorViewContributionContext,
  projectDecorationRangeThroughEdits,
  reindentEditsForRanges,
} from '@singapor/core/extensions'
import {
  applyEditorTheme,
  type EditorBlockHorizontalSurface,
  type EditorTheme,
} from '@singapor/core/rendering'
import {
  EditorSecondaryTextView,
  EditorSecondaryViewScheduler,
} from '@singapor/core/secondary-views'
import { createEmptySyntaxResult, treeSitterCapturesToEditorTokens } from '@singapor/core/syntax'
import { EditorPluginHost } from '@singapor/core/testing'
import { debugPieceTable } from '@singapor/core/debug'
import { createSelectionSet, type SelectionSet, VirtualizedTextView } from '@singapor/core/internal'
import {
  createMergeConflictDocumentText,
  EDITOR_MERGE_CONFLICT_FEATURE,
  parseMergeConflicts,
  type EditorState,
  type MergeConflictRegion,
} from '@singapor/core'

/** The keys a consumer cannot leave out, so that a field turning optional shows up as a break. */
type RequiredFields<T> = {
  [K in keyof T]-?: object extends Pick<T, K> ? never : K
}[keyof T]

describe('public API facade', () => {
  it('exports reviewed root entrypoints without internal debug surfaces', () => {
    const snapshot = createPieceTableSnapshot('abc')
    const edit: TextEdit = { from: 1, to: 2, text: 'B' }
    const state = { documentId: null } as EditorState
    // The category entrypoint is not the only door: hosts and framework bindings reach decorations
    // through the package root, so a name that survives only in `./extensions` still breaks them.
    const rootSpec: core.EditorDecorationSpec = { owner: 'test.root', start: 0, end: 3, text: {} }
    const rootDecoration: core.EditorDecoration = {
      ...rootSpec,
      id: 'test.root#0',
      startBias: 'right',
      endBias: 'left',
    }
    const rootSurfaces: core.EditorDecorationSurface[] = ['text', 'row', 'minimap']
    const rootRange: core.EditorDecorationRange | null = core.projectDecorationRangeThroughEdits(
      rootDecoration,
      [edit],
    )

    expect(Editor).toBeTypeOf('function')
    expect(
      createMergeConflictDocumentText({
        localPath: 'file.ts',
        localText: 'abc',
        remotePath: 'file.ts',
        remoteText: 'abc',
      }),
    ).toBe('abc')
    expect(parseMergeConflicts('')).toEqual([])
    expect(EDITOR_MERGE_CONFLICT_FEATURE.id).toBe('editor.mergeConflicts')
    expect(materializePieceTableFullText(snapshot)).toBe('abc')
    expect(readPieceTableTextRange(snapshot, 1, 3)).toBe('bc')
    expect(wordRangeAtOffset('abc', 1)).toEqual({ start: 0, end: 3 })
    expect(edit).toEqual({ from: 1, to: 2, text: 'B' })
    expect(core.EditorDecorationStore).toBeTypeOf('function')
    expect(rootSurfaces).toHaveLength(3)
    expect(rootRange?.end).toBe(3)
    expect({ index: 0 } as MergeConflictRegion).toMatchObject({ index: 0 })
    expect(state.documentId).toBeNull()
    expect('debugPieceTable' in core).toBe(false)
    expect('VirtualizedTextView' in core).toBe(false)
    expect('EditorPluginHost' in core).toBe(false)
    expect('defineLazyTextProperty' in core).toBe(false)
    expect('getPieceTableText' in core).toBe(false)
    expect('createAnchorSelection' in core).toBe(false)
  })

  it('exports the language configuration a host describes its own language with', () => {
    // A host shipping a language we have no grammar for writes the whole record itself, so every part
    // of it is in that host's build: the pairs, the comment tokens, the rules a line break consults
    // and the shape its blocks fold by. Registering through the root and reading back through the
    // category entrypoint also says the two doors reach one registry rather than a copy each.
    const pair: EditorAutoClosingPair = { close: 'end', open: 'do', quote: false }
    const brackets: EditorBracketPair[] = [{ close: 'end', open: 'do' }]
    const block: EditorBlockCommentTokens = { open: '#[', close: ']#' }
    const comments: EditorCommentTokens = { line: '#', block }
    const action: EditorEnterAction = { appendText: '# ', indentAction: 'none' }
    const onEnterRules: EditorOnEnterRule[] = [{ action, beforeText: /^\s*#/ }]
    const indentationRules: EditorIndentationRules = {
      decreaseIndentPattern: /^\s*end\b/,
      increaseIndentPattern: /\bdo\s*$/,
    }
    const folding: EditorFoldingRules = {
      offSide: true,
      regionEnd: /^\s*#\s*endregion\b/,
      regionStart: /^\s*#\s*region\b/,
    }
    const configuration: EditorLanguageConfiguration = {
      autoClosingPairs: [pair],
      brackets,
      comments,
      folding,
      indentationRules,
      listMarkers: true,
      onEnterRules,
    }
    const rootConfiguration: core.EditorLanguageConfiguration = configuration

    const registration = core.registerEditorLanguageConfiguration('fauxml', rootConfiguration)

    expect(editorLanguageConfiguration('FauxML ')).toBe(configuration)
    registration.dispose()

    expect(editorLanguageConfiguration('fauxml')).toBeNull()
  })

  it('exports the rules-driven reindent a plugin corrects rows through', () => {
    // A plugin that puts a row back where its own text belongs — after a paste, on a keystroke —
    // would otherwise carry a second copy of every language's indentation rules. It states the rows
    // as offsets and the settings as a record, so both of those types are in its build too.
    const ranges: readonly TextOffsetRange[] = [{ end: 15, start: 15 }]
    const options: EditorReindentOptions = { languageId: 'typescript', tabSize: 2 }
    const edits: readonly TextEdit[] = reindentEditsForRanges(
      'function f() {\nrun()\n}',
      ranges,
      options,
    )

    expect(edits).toEqual([{ from: 15, text: '  ', to: 15 }])
  })

  it('exports the shape a snippet source hands its tab stops over in', () => {
    // A completion source shipped elsewhere expands the snippet itself and states where the stops
    // landed. It builds that list before it has a context to pass it to, so the entry it builds —
    // including the copies a repeated stop is rendered into — has to be a type it can write down.
    const mirror: EditorSnippetMirror = { end: 12, start: 9, transform: (value) => value.trim() }
    const stops: readonly EditorSnippetStop[] = [
      { end: 7, mirrors: [mirror], start: 4 },
      { end: 20, start: 20 },
    ]

    expect(stops.map((stop) => stop.mirrors?.length ?? 0)).toEqual([1, 0])
    expect(mirror.transform?.(' a ')).toBe('a')
  })

  it('exports the language feature channel a source outside this package registers into', () => {
    // A completion or hover source shipped elsewhere — a snippet set, a second language server —
    // names the feature and says which documents it speaks for, so the constructor and both types
    // are in that package's build. It reaches the same feature as the plugin it joins by naming the
    // same id, which is why the two doors have to hand back the same identity for one.
    const throughRoot: core.EditorLanguageFeatureToken<{ readonly name: string }> =
      core.createEditorLanguageFeatureToken(' test.completionSources ')
    const restated: EditorLanguageFeatureToken<{ readonly name: string }> =
      createEditorLanguageFeatureToken('test.completionSources')
    const forLanguage: EditorLanguageFeatureSelector = { language: 'typescript', priority: 10 }
    const forAnything: EditorLanguageFeatureSelector = { language: '*' }

    expect(throughRoot.id).toBe(restated.id)
    expect(forLanguage.priority).toBe(10)
    expect(forAnything.language).toBe('*')
    expect(() => createEditorLanguageFeatureToken('  ')).toThrow()
  })

  it('exports the option registry the framework bindings iterate', () => {
    // Both bindings drive controlled options from this list rather than from a
    // hand-written effect each, so it is their contract with the editor and not
    // an internal detail: dropping or renaming it breaks their builds.
    expect(core.EDITOR_OPTION_DESCRIPTORS.length).toBeGreaterThan(0)
    expect(core.createEditorOptionSync).toBeTypeOf('function')
    for (const descriptor of core.EDITOR_OPTION_DESCRIPTORS) {
      expect(descriptor.name).toBeTypeOf('string')
      expect(descriptor.applyTo).toBeTypeOf('function')
    }
  })

  it('exports the whitespace modes a host can select', () => {
    // The union is part of EditorOptions, so a mode dropped back out of it is a
    // break in the bindings' builds rather than in anything here.
    const modes: core.HiddenCharactersMode[] = [
      'hidden',
      'show',
      'show-on-selection',
      'boundary',
      'trailing',
    ]

    expect(modes).toHaveLength(5)
  })

  it('exports the character classes and the separator set word motion accepts', () => {
    // A host switching over the class exhaustively stops compiling when a member is added, and a
    // host that classifies its own language passes the separators in, so the widened union and the
    // parameter are both part of its build rather than an argument this package alone chooses.
    const classes: TextCharacterClass[] = ['word', 'space', 'punctuation', 'newline']

    expect(classes).toHaveLength(4)
    expect(characterClassAt('a-b', 1, '-')).toBe('punctuation')
    expect(characterClassAt('a-b', 1, '')).toBe('word')
    expect(characterClassAt('a\nb', 1, '')).toBe('newline')
    expect(nextWordOffset('a-b c', 0, '-')).toBe(1)
    expect(nextWordOffset('a-b c', 0, '')).toBe(4)
    expect(nextWordOffset('a\nb', 1)).toBe(1)
    expect(previousWordOffset('a\nb', 2)).toBe(2)
  })

  it('exports every field a selection set a workspace package hands back must carry', () => {
    // @singapor/tree-sitter builds whole sets and returns them for the editor to adopt, so a field
    // that is not optional here is one its own build has to fill in.
    const required: RequiredFields<SelectionSet<number>>[] = [
      'selections',
      'lastAddedIndex',
      'normalized',
    ]
    const built = createSelectionSet([])

    expect(required).toHaveLength(3)
    expect(built.lastAddedIndex).toBe(0)
  })

  it('exports the command ids a keymap can bind', () => {
    // Hosts bind their own keys to these and switch over the union exhaustively, so an id renamed
    // or dropped is a break in their build rather than in anything here.
    const commands: core.EditorCommandId[] = [
      'editor.action.smartSelect.expand',
      'editor.action.smartSelect.shrink',
      'cursorColumnSelectLeft',
      'cursorColumnSelectRight',
      'cursorColumnSelectUp',
      'cursorColumnSelectDown',
      'cursorColumnSelectPageUp',
      'cursorColumnSelectPageDown',
      'editor.fold',
      'editor.unfold',
      'editor.foldRecursively',
      'editor.unfoldRecursively',
      'editor.foldAll',
      'editor.unfoldAll',
      'editor.foldLevel1',
      'editor.foldLevel2',
      'editor.foldLevel3',
      'editor.foldLevel4',
      'editor.foldLevel5',
      'editor.foldLevel6',
      'editor.foldLevel7',
      'editor.createFoldingRangeFromSelection',
      'editor.removeManualFoldingRanges',
    ]

    expect(commands).toHaveLength(23)
  })

  it('exports the hosting modes a block surface can declare', () => {
    // Which one a surface picks decides whether its DOM survives scrolling, so
    // a host chooses it and a mode dropped back out breaks the host's build.
    const hosting: EditorBlockHorizontalSurface['hosting'][] = ['inline', 'hoisted']

    expect(hosting).toHaveLength(2)
  })

  it('exports the overlay reservation a view contribution reads its inset from', () => {
    // Plugins outside this package position themselves against the edge other
    // overlays already claimed, so both the accessor and the sides it accepts
    // are part of their build.
    const reserved: NonNullable<EditorViewContributionContext['getReservedOverlayWidth']> = (
      side,
    ) => (side === 'right' ? 96 : 0)

    expect(reserved('right')).toBe(96)
    expect(reserved('left')).toBe(0)
  })

  it('exports the range tracking a view contribution hands its spans over to', () => {
    // A find shipped outside this package holds a scope and a batch of painted matches across edits
    // it never sees, and the two want opposite things at their edges, so the accessor, the bias it
    // takes and the handle it returns are all in that plugin's build.
    const region: EditorTrackedRanges = { resolve: () => [{ start: 0, end: 4 }] }
    const throughRoot: core.EditorTrackedRanges = region
    const track: NonNullable<EditorViewContributionContext['trackRanges']> = (ranges, bias) =>
      bias ? { resolve: () => ranges } : throughRoot

    expect(track([{ start: 1, end: 3 }]).resolve()).toEqual([{ start: 0, end: 4 }])
    expect(
      track([{ start: 1, end: 3 }], { startBias: 'right', endBias: 'left' }).resolve(),
    ).toEqual([{ start: 1, end: 3 }])
  })

  it('exports the snippet stops a completion source hands over for the editor to keep in step', () => {
    // A snippet source shipped outside this package — a server adapter, a snippet file — states
    // each stop together with the places its template writes that stop again, and hands over the
    // renderer for a copy it does not hold verbatim. Both the grouping and that renderer are part
    // of the contract it builds against, not a shape it has to guess at.
    let copies: readonly string[] = []
    const startSnippetSession: NonNullable<EditorEditContributionContext['startSnippetSession']> = (
      stops,
    ) => {
      copies = stops.flatMap((stop) =>
        (stop.mirrors ?? []).map((mirror) => mirror.transform?.('name') ?? 'name'),
      )
    }

    startSnippetSession([
      {
        start: 0,
        end: 4,
        mirrors: [
          { start: 7, end: 11 },
          { start: 14, end: 18, transform: (value) => value.toUpperCase() },
        ],
      },
      { start: 24, end: 24 },
    ])

    expect(copies).toEqual(['name', 'NAME'])
  })

  it('exposes the pass and cursor-history methods hosts drive the editor through', () => {
    for (const method of ['runInOperation', 'cursorUndo', 'cursorRedo']) {
      expect(Editor.prototype[method as keyof Editor]).toBeTypeOf('function')
    }
  })

  it('exposes named category entrypoints for public, test, internal, and debug consumers', () => {
    const host = new EditorPluginHost([])
    const syntax = createEmptySyntaxResult()
    const theme: EditorTheme = { foregroundColor: 'red' }
    const token = createEditorCapabilityToken('test.capability')
    // A plugin shipped outside this package hands its ranges to the store and reads them back, and
    // projects offsets it holds elsewhere through the same edit batch, so both the class and the
    // free function are part of its build rather than an internal the editor happens to share.
    const decorations = new EditorDecorationStore()
    const spec = {
      owner: 'test.decoration',
      start: 0,
      end: 3,
      text: {},
    } satisfies EditorDecorationSpec
    const surface: EditorDecorationSurface = 'text'
    const shifted: EditorDecorationRange | null = projectDecorationRangeThroughEdits(
      { start: 0, end: 3, startBias: 'right', endBias: 'left' },
      [{ from: 0, to: 0, text: 'x' }],
    )
    const findFeature = {
      openFind: () => false,
      toggleFind: () => false,
      openFindReplace: () => false,
      closeFind: () => false,
      findNext: () => false,
      findPrevious: () => false,
      replaceOne: () => false,
      replaceAll: () => false,
      selectAllMatches: () => false,
    } satisfies EditorFindFeature

    expect(EDITOR_FIND_FEATURE_ID).toBe('editor.find')
    expect(EDITOR_FIND_FEATURE.id).toBe('editor.find')
    expect(EDITOR_MINIMAP_FEATURE_ID).toBe('editor.minimap')
    expect(EDITOR_MINIMAP_FEATURE.id).toBe('editor.minimap')
    expect(decorations.add(spec)).toBeTypeOf('string')
    const stored: readonly EditorDecoration[] = decorations.decorationsInRange(surface, 0, 3)
    expect(stored.map((decoration) => decoration.owner)).toEqual(['test.decoration'])
    expect(shifted?.start).toBe(1)
    expect(findFeature.openFind()).toBe(false)
    expect(token.id).toBe('test.capability')
    expect(applyEditorTheme).toBeTypeOf('function')
    expect(theme.foregroundColor).toBe('red')
    expect(treeSitterCapturesToEditorTokens([])).toEqual([])
    expect(syntax.tokens).toEqual([])
    expect(debugPieceTable(createPieceTableSnapshot('abc')).length).toBeGreaterThan(0)
    expect(VirtualizedTextView).toBeTypeOf('function')
    expect(EditorSecondaryTextView).toBeTypeOf('function')
    expect(EditorSecondaryViewScheduler).toBeTypeOf('function')
    expect({} as EditorPluginContext).toMatchObject({})
    host.dispose()
  })
})
