import type {
  EditorBlock,
  EditorBlockAnchor,
  EditorBlockHorizontalSurface,
  EditorBlockMount,
  EditorBlockMountContext,
  EditorBlockProvider,
  EditorBlockProviderContext,
  EditorBlockVerticalSurface,
} from '@singapor/core/rendering'
import type { EditorDisposable, EditorPlugin } from '@singapor/core/extensions'
import type { ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

export type ReactEditorBlock = {
  readonly id: string
  readonly anchor: EditorBlockAnchor
  readonly top?: ReactEditorBlockHorizontalSurface
  readonly bottom?: ReactEditorBlockHorizontalSurface
  readonly left?: ReactEditorBlockVerticalSurface
  readonly right?: ReactEditorBlockVerticalSurface
}

export type ReactEditorBlockHorizontalSurface = Omit<EditorBlockHorizontalSurface, 'mount'>
export type ReactEditorBlockVerticalSurface = Omit<EditorBlockVerticalSurface, 'mount'>

export type ReactEditorBlockSurface =
  | ReactEditorBlockHorizontalSurface
  | ReactEditorBlockVerticalSurface

export type ReactEditorBlocksSource =
  | readonly ReactEditorBlock[]
  | ((context: EditorBlockProviderContext) => readonly ReactEditorBlock[])

export type ReactEditorBlocksPluginOptions = {
  readonly name?: string
  readonly blocks: ReactEditorBlocksSource
  readonly renderSurface: ReactEditorBlockSurfaceRenderer
  readonly onDidChangeBlocks?: (listener: () => void) => EditorDisposable
}

export type ReactEditorBlockSurfaceRenderer = (
  block: ReactEditorBlock,
  surface: ReactEditorBlockSurface,
  context: EditorBlockMountContext,
) => ReactNode

export function createReactEditorBlocksPlugin(
  options: ReactEditorBlocksPluginOptions,
): EditorPlugin {
  return {
    name: options.name ?? 'react-editor-blocks',
    activate: (context) => context.registerBlockProvider(createReactEditorBlockProvider(options)),
  }
}

function createReactEditorBlockProvider(
  options: ReactEditorBlocksPluginOptions,
): EditorBlockProvider {
  const provider: EditorBlockProvider = {
    getBlocks: (context) =>
      reactEditorBlocks(options.blocks, context).map((block) =>
        editorBlockFromReactBlock(block, options.renderSurface),
      ),
  }

  if (!options.onDidChangeBlocks) return provider

  return {
    ...provider,
    onDidChangeBlocks: options.onDidChangeBlocks,
  }
}

function reactEditorBlocks(
  blocks: ReactEditorBlocksSource,
  context: EditorBlockProviderContext,
): readonly ReactEditorBlock[] {
  if (typeof blocks !== 'function') return blocks

  return blocks(context)
}

function editorBlockFromReactBlock(
  block: ReactEditorBlock,
  renderSurface: ReactEditorBlockSurfaceRenderer,
): EditorBlock {
  return {
    id: block.id,
    anchor: block.anchor,
    top: editorBlockHorizontalSurface(block, 'top', renderSurface),
    bottom: editorBlockHorizontalSurface(block, 'bottom', renderSurface),
    left: editorBlockVerticalSurface(block, 'left', renderSurface),
    right: editorBlockVerticalSurface(block, 'right', renderSurface),
  }
}

function editorBlockHorizontalSurface(
  block: ReactEditorBlock,
  slot: 'top' | 'bottom',
  renderSurface: ReactEditorBlockSurfaceRenderer,
): EditorBlockHorizontalSurface | undefined {
  const surface = block[slot]
  if (!surface) return undefined

  return {
    height: surface.height,
    mount: createReactEditorBlockMount(block, surface, renderSurface),
    ...(surface.hosting ? { hosting: surface.hosting } : {}),
  }
}

function editorBlockVerticalSurface(
  block: ReactEditorBlock,
  slot: 'left' | 'right',
  renderSurface: ReactEditorBlockSurfaceRenderer,
): EditorBlockVerticalSurface | undefined {
  const surface = block[slot]
  if (!surface) return undefined

  return {
    width: surface.width,
    mount: createReactEditorBlockMount(block, surface, renderSurface),
  }
}

function createReactEditorBlockMount(
  block: ReactEditorBlock,
  surface: ReactEditorBlockSurface,
  renderSurface: ReactEditorBlockSurfaceRenderer,
): EditorBlockMount {
  return (container, context) =>
    mountReactEditorBlockSurface(container, renderSurface(block, surface, context))
}

function mountReactEditorBlockSurface(
  container: HTMLElement,
  children: ReactNode,
): EditorDisposable {
  const root = createRoot(container)

  try {
    renderSurface(root, children)
  } catch (error) {
    root.unmount()
    throw error
  }

  return disposableOnce(() => {
    root.unmount()
  })
}

function renderSurface(root: Root, children: ReactNode): void {
  root.render(children)
}

function disposableOnce(dispose: () => void): EditorDisposable {
  let disposed = false

  return {
    dispose: () => {
      if (disposed) return

      disposed = true
      dispose()
    },
  }
}
