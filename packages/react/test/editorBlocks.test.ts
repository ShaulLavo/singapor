import { Editor } from '@singapor/core/editor'
import { act, createElement, useEffect, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createReactEditorBlocksPlugin,
  type ReactEditorBlock,
  type ReactEditorBlockSurface,
} from '../src'

class MockHighlight extends Set<Range> {}

type ActEnvironment = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

beforeEach(() => {
  ;(globalThis as ActEnvironment).IS_REACT_ACT_ENVIRONMENT = true
  // @ts-expect-error happy-dom does not provide Highlight.
  globalThis.Highlight = MockHighlight
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'Highlight')
  Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
  document.body.replaceChildren()
})

describe('createReactEditorBlocksPlugin', () => {
  it('renders block surfaces through React portals', async () => {
    const unmounted: string[] = []
    const container = document.createElement('div')
    document.body.append(container)

    const plugin = createReactEditorBlocksPlugin({
      blocks: [blockFixture('file')],
      renderSurface: (block, surface, context) =>
        createElement(SurfaceProbe, {
          label: `${context.surface}:${block.id}:${fixedSurfacePx(surface)}`,
          onUnmount: (label) => unmounted.push(label),
        }),
    })

    let editor!: Editor
    act(() => {
      editor = new Editor(container, {
        defaultText: 'one\ntwo',
        lineHeight: 20,
        plugins: [plugin],
      })
    })

    expect(surfaceTexts(container)).toEqual(['top:file:24'])

    await act(async () => {
      editor.dispose()
      await flushReactBlockTasks()
    })

    expect(unmounted).toEqual(['top:file:24'])
  })

  it('unmounts React surfaces when blocks change', async () => {
    const disposed: string[] = []
    const container = document.createElement('div')
    let listener: () => void = () => {}
    let blockId = 'first'
    document.body.append(container)

    const plugin = createReactEditorBlocksPlugin({
      blocks: () => [blockFixture(blockId)],
      onDidChangeBlocks: (nextListener) => {
        listener = nextListener
        return { dispose: () => disposed.push('provider') }
      },
      renderSurface: (block) =>
        createElement(SurfaceProbe, {
          label: block.id,
          onUnmount: (label) => disposed.push(`surface:${label}`),
        }),
    })

    let editor!: Editor
    act(() => {
      editor = new Editor(container, {
        defaultText: 'one\ntwo',
        plugins: [plugin],
      })
    })

    expect(surfaceTexts(container)).toEqual(['first'])

    blockId = 'second'
    await act(async () => {
      listener()
      await flushReactBlockTasks()
    })

    expect(surfaceTexts(container)).toEqual(['second'])
    expect(disposed).toEqual(['surface:first'])

    await act(async () => {
      editor.dispose()
      await flushReactBlockTasks()
    })

    expect(disposed).toContain('surface:second')
    expect(disposed).toContain('provider')
  })

  it('unmounts React surfaces when virtualized rows move out of view', async () => {
    const unmounted: string[] = []
    const container = document.createElement('div')
    const text = Array.from({ length: 120 }, (_value, index) => `line ${index}`).join('\n')
    document.body.append(container)

    const plugin = createReactEditorBlocksPlugin({
      blocks: [blockFixture('top-row')],
      renderSurface: (block) =>
        createElement(SurfaceProbe, {
          label: block.id,
          onUnmount: (label) => unmounted.push(label),
        }),
    })

    let editor!: Editor
    act(() => {
      editor = new Editor(container, {
        defaultText: text,
        lineHeight: 20,
        plugins: [plugin],
      })
    })

    expect(surfaceTexts(container)).toEqual(['top-row'])

    await act(async () => {
      editor.setScrollPosition({ top: 1_600, left: 0 })
      await flushReactBlockTasks()
    })

    expect(surfaceTexts(container)).toEqual([])
    expect(unmounted).toEqual(['top-row'])

    await act(async () => {
      editor.dispose()
      await flushReactBlockTasks()
    })
  })
})

function blockFixture(id: string): ReactEditorBlock {
  return {
    id,
    anchor: { row: 0 },
    top: {
      height: { px: 24 },
    },
  }
}

function SurfaceProbe({
  label,
  onUnmount,
}: {
  readonly label: string
  readonly onUnmount: (label: string) => void
}): ReactElement {
  useEffect(() => () => onUnmount(label), [label, onUnmount])

  return createElement('span', { 'data-react-block-surface': label }, label)
}

function surfaceTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-react-block-surface]')).map(
    (surface) => surface.textContent ?? '',
  )
}

async function flushReactBlockTasks(): Promise<void> {
  await Promise.resolve()
}

function fixedSurfacePx(surface: ReactEditorBlockSurface): number {
  if (surface.width) return surface.width.px ?? 0
  if (surface.height) return surface.height.px ?? 0

  return 0
}
