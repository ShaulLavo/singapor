import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EditorBlockSurfaceController } from '../src/editor/blockSurfaceController'
import type { EditorBlockMountContext, EditorBlockProvider } from '../src/editorBlocks'
import { type VirtualizedTextHighlightRegistry, VirtualizedTextView } from '../src/virtualization'

const highlightsMap = new Map<string, Highlight>()
const mockRegistry: VirtualizedTextHighlightRegistry = {
  set: (name, highlight) => {
    highlightsMap.set(name, highlight)
  },
  delete: (name) => highlightsMap.delete(name),
}

describe('block surface scroll anchoring', () => {
  let container: HTMLElement
  let view: VirtualizedTextView
  let controller: EditorBlockSurfaceController

  beforeEach(() => {
    highlightsMap.clear()
    // @ts-expect-error happy-dom does not provide Highlight.
    globalThis.Highlight = Set
    container = document.createElement('div')
    document.body.appendChild(container)
    view = new VirtualizedTextView(container, {
      rowHeight: 20,
      overscan: 0,
      highlightRegistry: mockRegistry,
      selectionHighlightName: 'test-selection',
      blockRowMount: (element, row) => controller.mountRow(element, row),
    })
    controller = new EditorBlockSurfaceController({
      getDocumentId: () => 'doc',
      getLineCount: () => view.getState().lineCount,
      materializeFullText: () => '',
      applyBlockRows: (rows) => view.setBlockRows(rows),
      applyBlockLanes: (lanes) => view.setBlockLanes(lanes),
      focusEditor: () => {},
      setSelection: () => {},
      notifyLayout: () => {},
    })
  })

  afterEach(() => {
    controller.dispose()
    view.dispose()
    container.remove()
    Reflect.deleteProperty(globalThis, 'Highlight')
  })

  it('keeps the reading position when a block above the viewport settles taller', async () => {
    let mountContext: EditorBlockMountContext | null = null
    let blockElement: HTMLElement | null = null

    view.setText(documentLines(200))
    controller.sync([
      blockProvider((element, context) => {
        blockElement = element
        mountContext = context
      }),
    ])
    view.setScrollMetrics(0, 100)
    view.setScrollMetrics(1_000, 100)

    expect(view.getState()).toMatchObject({ scrollTop: 1_000, visibleRange: { start: 50 } })
    expect(topVisibleLine(view)).toBe('line 49')

    measureAs(blockElement, 300)
    mountContext!.requestMeasure()
    await flushMeasurements()

    expect(topVisibleLine(view)).toBe('line 49')
    expect(view.getState()).toMatchObject({ scrollTop: 1_280, visibleRange: { start: 50 } })
  })
})

function blockProvider(
  mount: (element: HTMLElement, context: EditorBlockMountContext) => void,
): EditorBlockProvider {
  return {
    getBlocks: () => [
      {
        id: 'preview',
        anchor: { row: 2 },
        top: { height: { minPx: 20, maxPx: 400 }, mount },
      },
    ],
  }
}

function topVisibleLine(view: VirtualizedTextView): string | undefined {
  return view.getState().mountedRows[0]?.text
}

function documentLines(count: number): string {
  return Array.from({ length: count }, (_value, line) => `line ${line}`).join('\n')
}

// happy-dom reports every rect empty, so a block reports its height the way a
// loaded image would.
function measureAs(element: HTMLElement | null, height: number): void {
  element!.getBoundingClientRect = () => ({ height, width: 0 }) as DOMRect
}

function flushMeasurements(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
