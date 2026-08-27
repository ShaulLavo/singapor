import { describe, expect, it } from 'vitest'
import type { EditorViewSnapshot } from '@singapor/core/extensions'
import { resolveMinimapOptions } from '../src/options'
import { canUseMinimapWorker, MinimapWorkerClient, type MinimapHost } from '../src/workerClient'

describe.skipIf(!canUseMinimapWorker())('MinimapWorkerClient', () => {
  it('renders through OffscreenCanvas and updates host layout', async () => {
    const host = createHost()
    const client = new MinimapWorkerClient({
      host,
      options: resolveMinimapOptions(),
      snapshot: snapshot('const value = 1;\nconsole.log(value);'),
      decorations: [],
      onLayoutWidth: (width) => {
        host.root.dataset.width = String(width)
      },
      reservedLane: () => 0,
    })

    await waitFor(() => Number(host.root.dataset.width) > 0 && host.slider.style.display !== '')

    expect(Number(host.root.dataset.width)).toBeGreaterThan(0)
    expect(host.slider.style.display).toMatch(/block|none/)

    client.dispose()
    host.root.remove()
    host.colorScope.remove()
  })
})

function createHost(): MinimapHost {
  const root = document.createElement('div')
  const colorScope = document.createElement('div')
  const shadow = document.createElement('div')
  const mainCanvas = document.createElement('canvas')
  const decorationsCanvas = document.createElement('canvas')
  const slider = document.createElement('div')
  const sliderHorizontal = document.createElement('div')
  root.style.fontFamily = 'monospace'
  root.style.color = 'rgb(212, 212, 212)'
  root.style.backgroundColor = 'rgb(30, 30, 30)'
  colorScope.style.fontFamily = 'monospace'
  colorScope.style.color = 'rgb(212, 212, 212)'
  colorScope.style.backgroundColor = 'rgb(30, 30, 30)'
  colorScope.style.setProperty('--editor-syntax-keyword', '#ff0000')
  slider.appendChild(sliderHorizontal)
  root.append(shadow, mainCanvas, decorationsCanvas, slider)
  document.body.append(colorScope, root)
  return { root, colorScope, shadow, mainCanvas, decorationsCanvas, slider, sliderHorizontal }
}

function snapshot(text: string): EditorViewSnapshot {
  return {
    documentId: 'test.ts',
    languageId: 'typescript',
    fullText: text,
    textVersion: 1,
    documentSyncPoint: {
      revision: 1,
      segment: Object.freeze({}) as EditorViewSnapshot['documentSyncPoint']['segment'],
      textVersion: 1,
    },
    changesSinceDocumentSyncPoint: () => null,
    lineStarts: lineStarts(text),
    tokens: [{ start: 0, end: 5, style: { color: 'var(--editor-syntax-keyword)' } }],
    brackets: [],
    selections: [
      { anchorOffset: 0, headOffset: 5, startOffset: 0, endOffset: 5, affinity: 'after' },
    ],
    metrics: { rowHeight: 20, characterWidth: 8 },
    lineCount: 2,
    contentWidth: 160,
    totalHeight: 40,
    tabSize: 4,
    foldMarkers: [],
    visibleRows: [],
    viewport: {
      scrollTop: 0,
      scrollLeft: 0,
      scrollHeight: 40,
      scrollWidth: 160,
      clientHeight: 200,
      clientWidth: 400,
      borderBoxHeight: 200,
      borderBoxWidth: 400,
      visibleRange: { start: 0, end: 2 },
    },
  }
}

function lineStarts(text: string): readonly number[] {
  const starts = [0]
  let index = text.indexOf('\n')
  while (index !== -1) {
    starts.push(index + 1)
    index = text.indexOf('\n', index + 1)
  }
  return starts
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for minimap worker')
}
