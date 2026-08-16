import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Editor } from '../src/editor'
import { InputSelectionController } from '../src/editor/inputSelectionController'
import { VirtualizedTextView } from '../src/virtualization'
import { resetEditorInstanceCount } from '../src/public/testing'
import type { DocumentSessionChange } from '../src/public/document'
import type { EditorPlugin, EditorViewContributionUpdateKind } from '../src/public/extensions'

// Non-ASCII forces the measured geometry path, where a row is measured one
// grapheme at a time against its own rect.
const MEASURED_ROW_TEXT = 'ünïcödé rôw'
const MEASURED_ROW_GRAPHEMES = 11

function createViewContributionPlugin(kinds: EditorViewContributionUpdateKind[]): EditorPlugin {
  return {
    activate: (context) =>
      context.registerViewContribution({
        createContribution: () => ({
          update: (_snapshot, kind) => {
            kinds.push(kind)
          },
        }),
      }),
  }
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    toJSON: () => ({}),
    top,
    width,
    x: left,
    y: top,
  } as DOMRect
}

/**
 * Layout is inert here, so every rect would come back empty and the measured
 * geometry path would bail before it ever asks a row where it is.
 */
function stubLayout(): (element: Element) => number {
  const glyph = rect(0, 0, 8, 16)
  vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(
    () => ({ item: () => glyph, length: 1 }) as unknown as DOMRectList,
  )

  const reads = new Map<Element, number>()
  const box = rect(0, 0, 400, 400)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    reads.set(this, (reads.get(this) ?? 0) + 1)
    return box
  })
  return (element) => reads.get(element) ?? 0
}

function mountMeasuredRowView(host: HTMLElement): VirtualizedTextView {
  const viewContainer = document.createElement('div')
  host.appendChild(viewContainer)
  const view = new VirtualizedTextView(viewContainer, { overscan: 0, rowHeight: 20 })
  view.setText(MEASURED_ROW_TEXT)
  view.setScrollMetrics(0, 40)
  return view
}

function mountedRowElement(view: VirtualizedTextView): HTMLElement {
  const row = view.getState().mountedRows[0]
  if (!row) throw new Error('no mounted row')
  return row.element
}

/** Retires the cached row geometry so the next probe measures the row again. */
function rebuildRowGeometry(
  view: VirtualizedTextView,
  readsFor: (element: Element) => number,
): { readonly element: HTMLElement; readonly reads: number } {
  view.setText(`${MEASURED_ROW_TEXT} `)
  const element = mountedRowElement(view)
  return { element, reads: readsFor(element) }
}

function createChangeRecordingPlugin(
  edits: (readonly { readonly from: number; readonly to: number; readonly text: string }[])[],
): EditorPlugin {
  return {
    activate: (context) =>
      context.registerDecorationContribution({
        createContribution: () => ({
          handleEditorChange: (change) => {
            if (change) edits.push(change.edits)
          },
          dispose: () => undefined,
        }),
      }),
  }
}

describe('editor operations', () => {
  let container: HTMLElement
  let editor: Editor

  beforeEach(() => {
    resetEditorInstanceCount()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    editor.dispose()
    container.remove()
    vi.restoreAllMocks()
  })

  it('reveals, syncs the DOM selection and notifies once for a whole pass', () => {
    const kinds: EditorViewContributionUpdateKind[] = []
    const changes: unknown[] = []
    editor = new Editor(container, {
      defaultText: 'abc',
      onChange: (_state, change) => {
        if (change) changes.push(change)
      },
      plugins: [createViewContributionPlugin(kinds)],
    })
    const reveal = vi.spyOn(VirtualizedTextView.prototype, 'revealOffset')
    const sync = vi.spyOn(InputSelectionController.prototype, 'syncDomSelection')
    kinds.length = 0

    editor.runInOperation(() => {
      editor.edit({ from: 0, to: 0, text: 'x' })
      editor.edit({ from: 1, to: 1, text: 'y' })
      editor.setSelection(2, 2)
    })

    expect(editor.materializeFullText()).toBe('xyabc')
    expect(changes).toHaveLength(1)
    expect(sync).toHaveBeenCalledTimes(1)
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(kinds.filter((kind) => kind === 'content')).toHaveLength(1)
    // A caret move is the last change of the pass but not its widest one.
    expect(kinds.at(-1)).toBe('content')
  })

  it('hands listeners the end of the pass, not the first change in it', () => {
    const changes: DocumentSessionChange[] = []
    editor = new Editor(container, {
      defaultText: 'abc',
      onChange: (_state, change) => {
        if (change) changes.push(change)
      },
    })

    editor.runInOperation(() => {
      editor.edit({ from: 0, to: 0, text: 'x' })
      editor.edit({ from: 1, to: 1, text: 'y' })
      editor.setSelection(2, 2)
    })

    const notified = changes.at(-1)
    // Anything short of the whole pass describes a document that is already two
    // changes out of date by the time it is handed over.
    expect(editor.materializeFullText()).toBe('xyabc')
    expect(notified?.textSnapshot.materializeFullText()).toBe(editor.materializeFullText())
  })

  it('leaves the DOM selection alone for a pass whose changes all opted out', () => {
    editor = new Editor(container, { defaultText: 'abc' })
    const sync = vi.spyOn(InputSelectionController.prototype, 'syncDomSelection')

    editor.setSelection(1, 1)

    expect(editor.getState().cursor).toMatchObject({ column: 1, row: 0 })
    expect(sync).not.toHaveBeenCalled()
  })

  it('keeps the reveal an earlier change asked for when a later one asks for none', () => {
    editor = new Editor(container, { defaultText: 'abcdefgh' })
    const reveal = vi.spyOn(VirtualizedTextView.prototype, 'revealOffset')

    editor.runInOperation(() => {
      editor.setSelection(5, 5)
      editor.edit({ from: 0, to: 0, text: 'x' })
    })

    expect(reveal).toHaveBeenCalledTimes(1)
    expect(reveal).toHaveBeenCalledWith(5, undefined)
  })

  it('runs a nested pass inline rather than opening a second one', () => {
    const changes: unknown[] = []
    editor = new Editor(container, {
      defaultText: 'abc',
      onChange: (_state, change) => {
        if (change) changes.push(change)
      },
    })

    editor.runInOperation(() => {
      editor.runInOperation(() => {
        editor.edit({ from: 0, to: 0, text: 'x' })
      })
      expect(changes).toHaveLength(0)
      editor.edit({ from: 1, to: 1, text: 'y' })
    })

    expect(changes).toHaveLength(1)
    expect(editor.materializeFullText()).toBe('xyabc')
  })

  it('closes a pass that throws part-way, so the next edit still notifies', () => {
    const changes: unknown[] = []
    editor = new Editor(container, {
      defaultText: 'abc',
      onChange: (_state, change) => {
        if (change) changes.push(change)
      },
    })

    expect(() =>
      editor.runInOperation(() => {
        editor.edit({ from: 0, to: 0, text: 'x' })
        throw new Error('pass failed')
      }),
    ).toThrow('pass failed')
    editor.edit({ from: 0, to: 0, text: 'y' })

    expect(changes).toHaveLength(2)
    expect(editor.materializeFullText()).toBe('yxabc')
  })

  it('closes the pass when a listener throws, so the next edit still notifies', () => {
    let failing = true
    const changes: unknown[] = []
    editor = new Editor(container, {
      defaultText: 'abc',
      onChange: (_state, change) => {
        if (!change) return
        if (failing) throw new Error('listener failed')

        changes.push(change)
      },
    })

    expect(() => editor.edit({ from: 0, to: 0, text: 'x' })).toThrow('listener failed')
    failing = false
    editor.edit({ from: 0, to: 0, text: 'y' })

    expect(changes).toHaveLength(1)
    expect(editor.materializeFullText()).toBe('yxabc')
  })

  it('measures a row rect once per pass instead of once per grapheme', () => {
    editor = new Editor(container, { defaultText: 'abc' })
    const readsFor = stubLayout()
    const view = mountMeasuredRowView(container)

    view.textOffsetFromViewportPoint(0, 0)
    const outsideReads = readsFor(mountedRowElement(view))
    const inside = rebuildRowGeometry(view, readsFor)
    editor.runInOperation(() => {
      view.textOffsetFromViewportPoint(0, 0)
    })
    const insideReads = readsFor(inside.element) - inside.reads

    view.dispose()
    expect(outsideReads).toBeGreaterThanOrEqual(MEASURED_ROW_GRAPHEMES)
    expect(insideReads).toBe(1)
  })

  it('forgets measured row rects at the end of the pass', () => {
    editor = new Editor(container, { defaultText: 'abc' })
    const readsFor = stubLayout()
    const view = mountMeasuredRowView(container)

    editor.runInOperation(() => {
      view.textOffsetFromViewportPoint(0, 0)
    })
    const next = rebuildRowGeometry(view, readsFor)
    editor.runInOperation(() => {
      view.textOffsetFromViewportPoint(0, 0)
    })
    const nextReads = readsFor(next.element) - next.reads

    view.dispose()
    // A rect kept past the close would be served into a document that has been
    // re-rendered since it was read.
    expect(nextReads).toBe(1)
  })

  it('re-measures a row rect after a render inside the same pass', () => {
    editor = new Editor(container, { defaultText: 'abc' })
    const readsFor = stubLayout()
    const view = mountMeasuredRowView(container)
    const element = mountedRowElement(view)

    let reads = 0
    let recycled = false
    editor.runInOperation(() => {
      view.textOffsetFromViewportPoint(0, 0)
      editor.edit({ from: 0, to: 0, text: 'z' })
      const rebuilt = rebuildRowGeometry(view, readsFor)
      recycled = rebuilt.element === element
      view.textOffsetFromViewportPoint(0, 0)
      reads = readsFor(rebuilt.element) - rebuilt.reads
    })

    view.dispose()
    // The rect is remembered per row element, so the row has to be the same one
    // for a stale rect to be reachable at all.
    expect(recycled).toBe(true)
    // The render moved the row, and every part of it measured against the rect
    // read beforehand would be offset by however far it travelled.
    expect(reads).toBe(1)
  })

  it('keeps measured row rects when a second editor closes a pass inside this one', () => {
    editor = new Editor(container, { defaultText: 'abc' })
    const secondContainer = document.createElement('div')
    document.body.appendChild(secondContainer)
    const secondEditor = new Editor(secondContainer, { defaultText: 'abc' })
    const readsFor = stubLayout()
    const view = mountMeasuredRowView(container)
    const element = mountedRowElement(view)

    let reads = 0
    let recycled = false
    editor.runInOperation(() => {
      view.textOffsetFromViewportPoint(0, 0)
      secondEditor.runInOperation(() => {})
      const rebuilt = rebuildRowGeometry(view, readsFor)
      recycled = rebuilt.element === element
      view.textOffsetFromViewportPoint(0, 0)
      reads = readsFor(rebuilt.element) - rebuilt.reads
    })

    view.dispose()
    secondEditor.dispose()
    secondContainer.remove()
    expect(recycled).toBe(true)
    // Two editors on one page overlap their passes, and the inner one finishing
    // says nothing about whether the outer one is still measuring.
    expect(reads).toBe(0)
  })
})

describe('pass hand-off', () => {
  let container: HTMLElement
  let editor: Editor

  beforeEach(() => {
    resetEditorInstanceCount()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    editor.dispose()
    container.remove()
  })

  it('hands every change of a pass to the incremental consumers, in order', () => {
    const edits: (readonly {
      readonly from: number
      readonly to: number
      readonly text: string
    }[])[] = []
    editor = new Editor(container, {
      defaultText: 'alpha beta',
      plugins: [createChangeRecordingPlugin(edits)],
    })
    edits.length = 0

    editor.runInOperation(() => {
      editor.edit({ from: 0, to: 5, text: 'ALPHA' })
      editor.edit({ from: 6, to: 10, text: 'BETA' })
    })

    // Syntax is reparsed from one change onto the one before it, so a pass that
    // hands over only its last change leaves the tree derived from a snapshot
    // that never existed.
    expect(edits.map((pass) => pass.map((edit) => edit.text))).toEqual([['ALPHA'], ['BETA']])
  })

  it('lets a listener that edits from inside the flush open a pass of its own', () => {
    const seen: string[] = []
    let injected = false
    editor = new Editor(container, {
      defaultText: 'alpha',
      onChange: () => {
        seen.push(editor.materializeFullText())
        if (injected) return

        injected = true
        editor.edit({ from: 5, to: 5, text: '!' })
      },
    })

    editor.edit({ from: 0, to: 5, text: 'ALPHA' })

    // Two passes, not one: the nested edit cannot append to a pass that has
    // already been drained, or it is applied to the document and reported to
    // nobody.
    expect(seen).toEqual(['ALPHA', 'ALPHA!'])
    expect(editor.materializeFullText()).toBe('ALPHA!')
  })
})
