import { expect, it } from 'vitest'
import { commands } from 'vitest/browser'
import { VirtualizedTextView } from '../src/virtualization'
import { Editor } from '../src/editor/Editor'
import { createEditorBufferSession, createEditorTextBuffer } from '../src/public/document'
import type { EditorViewContributionContext } from '../src/plugins'
import '../src/style.css'

declare module 'vitest/browser' {
  interface BrowserCommands {
    proofViewportScreenshot: (hostId: string) => Promise<string>
  }
}

it('clips every document paint layer before either rail through native scrolling and visibility changes', async () => {
  const host = document.createElement('div')
  host.id = 'code-viewport-proof'
  host.style.cssText =
    'display:flex;width:400px;height:180px;background:linear-gradient(90deg,#123,#234)'
  document.body.append(host)
  const view = new VirtualizedTextView(host, { rowHeight: 20, overscan: 0 })
  const scroll = view.scrollElement
  scroll.style.background = 'transparent'
  view.setText(
    Array.from({ length: 180 }, (_, row) => `${row}: ${'abcdefghij '.repeat(50)}`).join('\n'),
  )
  view.setSelection(0, 4000)

  try {
    for (const side of ['right', 'left'] as const) {
      view.reserveOverlayWidth(side === 'right' ? 'left' : 'right', 0)
      view.reserveOverlayWidth(side, 96)
      for (const visibility of ['auto', 'none']) {
        scroll.style.scrollbarWidth = visibility
        await expect.poll(() => view.getState().viewportWidth).toBe(scroll.clientWidth - 96)
        await assertClippedScroll(view, host, side)
      }
    }
    view.reserveOverlayWidth('left', 0)
    await expect.poll(() => view.getState().viewportWidth).toBe(scroll.clientWidth)
    expect(view.getState().mountedRows.length).toBeGreaterThan(0)
    expect(scroll.getBoundingClientRect().right).toBe(host.getBoundingClientRect().right)
  } finally {
    view.dispose()
    host.remove()
  }
})

it('keeps newly typed text and the caret visible at the clipped right edge', async () => {
  const host = document.createElement('div')
  host.style.cssText = 'display:flex;width:400px;height:180px'
  document.body.append(host)
  const editor = new Editor(host, {
    plugins: [
      {
        name: 'reserved-rail',
        activate: (context) =>
          context.registerViewContribution({ createContribution: reserveRail }),
      },
    ],
  })
  const text = 'abcdefghij '.repeat(50)
  const buffer = createEditorTextBuffer(text)
  editor.attachSession(createEditorBufferSession(buffer), { documentId: 'typing.txt' })
  const viewport = host.querySelector('.editor-virtualized-viewport')!
  const caret = host.querySelector('.editor-virtualized-caret')!
  const scroll = host.querySelector<HTMLDivElement>('.editor-virtualized')!

  try {
    await expect.poll(() => viewport.getBoundingClientRect().width).toBeGreaterThan(0)
    editor.setSelection(text.length, text.length)
    editor.focus()
    await commands.proofKeyPress('End')
    expect(caret.getBoundingClientRect().right).toBeLessThanOrEqual(
      viewport.getBoundingClientRect().right,
    )
    const before = scroll.scrollLeft
    for (const character of 'typing_past_the_edge') await commands.proofKeyPress(character)
    expect(buffer.materializeFullText()).toBe(`${text}typing_past_the_edge`)
    expect(scroll.scrollLeft).toBeGreaterThan(before)
    expect(caret.getBoundingClientRect().right).toBeLessThanOrEqual(
      viewport.getBoundingClientRect().right,
    )
  } finally {
    editor.dispose()
    host.remove()
  }
})

function reserveRail(context: EditorViewContributionContext) {
  context.reserveOverlayWidth('right', 96)
  return { update() {}, dispose: () => context.reserveOverlayWidth('right', 0) }
}

async function assertClippedScroll(
  view: VirtualizedTextView,
  host: HTMLElement,
  side: 'left' | 'right',
) {
  for (const [left, top] of [
    [0, 0],
    [650, 1600],
  ] as const) {
    view.scrollElement.scrollTo(left, top)
    await expect.poll(() => view.getState().scrollTop).toBe(top)
    await expect.poll(() => view.getState().scrollLeft).toBe(left)
    const painted = await pixels(host.id)
    view.contentElement.style.visibility = 'hidden'
    const background = await pixels(host.id)
    view.contentElement.style.visibility = ''
    const clip = host.querySelector('.editor-virtualized-viewport')!.getBoundingClientRect()
    const bounds = host.getBoundingClientRect()
    const scale = painted.width / bounds.width
    const railStart = side === 'right' ? Math.ceil((clip.right - bounds.left) * scale) : 0
    const railEnd = side === 'right' ? painted.width : Math.floor((clip.left - bounds.left) * scale)
    const changed = changedPixels(painted, background, railStart, railEnd)
    expect(changed.rail).toBe(0)
    expect(changed.content).toBeGreaterThan(200)
    expect(view.textOffsetFromPoint(clip.left + 30, clip.top + 10)).not.toBeNull()
  }
}

async function pixels(hostId: string): Promise<ImageData> {
  const screenshot = await commands.proofViewportScreenshot(hostId)
  const bytes = Uint8Array.from(atob(screenshot), (character) => character.charCodeAt(0))
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const context = canvas.getContext('2d')!
  context.drawImage(bitmap, 0, 0)
  bitmap.close()
  return context.getImageData(0, 0, canvas.width, canvas.height)
}

function changedPixels(
  painted: ImageData,
  background: ImageData,
  railStart: number,
  railEnd: number,
) {
  let rail = 0
  let content = 0
  for (let offset = 0; offset < painted.data.length; offset += 4) {
    if (
      painted.data[offset] === background.data[offset] &&
      painted.data[offset + 1] === background.data[offset + 1] &&
      painted.data[offset + 2] === background.data[offset + 2]
    )
      continue
    const x = (offset / 4) % painted.width
    if (x >= railStart && x < railEnd) rail++
    else content++
  }
  return { rail, content }
}
