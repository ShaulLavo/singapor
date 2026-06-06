import { Window } from 'happy-dom'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { EditorBlockProvider } from '../editorBlocks'
import { createEditorLoggingPlugin } from '../logging'
import type {
  EditorCapabilityToken,
  EditorDisposable,
  EditorGutterContribution,
  EditorLogEvent,
  EditorPlugin,
  EditorPluginContext,
} from '../plugins'
import { createEditorCapabilityToken, EditorPluginHost } from '../plugins'
import type { EditorOptions } from './types'
import { setHighlightRegistry } from './runtime'
import { Editor } from './Editor'

type TestWindow = Window & typeof globalThis

const highlightRegistry = {
  set: () => undefined,
  delete: () => true,
}

describe('editor plugin lifecycle', () => {
  let cleanupDom: (() => void) | null = null

  beforeEach(() => {
    cleanupDom = installDom()
    setHighlightRegistry(highlightRegistry)
  })

  afterEach(() => {
    setHighlightRegistry(undefined)
    cleanupDom?.()
    cleanupDom = null
  })

  test('retains plugin identity across repeated setPlugins calls', () => {
    const editor = createEditor()
    const lifecycle = createLifecyclePlugin()

    editor.setPlugins([lifecycle.plugin])
    editor.setPlugins([lifecycle.plugin])

    expect(lifecycle.activations).toBe(1)
    expect(lifecycle.disposals).toBe(0)

    editor.setPlugins([])

    expect(lifecycle.disposals).toBe(1)
    editor.dispose()
  })

  test('uses one host context across plugin activations', () => {
    const editor = createEditor()
    const contexts: EditorPluginContext[] = []
    const first = createContextCapturePlugin(contexts)
    const second = createContextCapturePlugin(contexts)

    editor.setPlugins([first, second])

    expect(contexts).toHaveLength(2)
    expect(contexts[0]).toBe(contexts[1])
    editor.dispose()
  })

  test('removePlugin removes managed and manual ownership', () => {
    const editor = createEditor()
    const lifecycle = createLifecyclePlugin()
    const lease = editor.addPlugin(lifecycle.plugin)

    editor.setPlugins([lifecycle.plugin])
    expect(editor.removePlugin(lifecycle.plugin)).toBe(true)
    lease.dispose()

    expect(lifecycle.activations).toBe(1)
    expect(lifecycle.disposals).toBe(1)
    editor.dispose()
  })

  test('duplicate manual plugin add does not create reference-counted ownership', () => {
    const editor = createEditor()
    const lifecycle = createLifecyclePlugin()
    const firstLease = editor.addPlugin(lifecycle.plugin)
    const duplicateLease = editor.addPlugin(lifecycle.plugin)

    expect(lifecycle.activations).toBe(1)

    duplicateLease.dispose()
    expect(lifecycle.disposals).toBe(0)

    firstLease.dispose()
    expect(lifecycle.disposals).toBe(1)
    editor.dispose()
  })

  test('runs plugin install activate update deactivate and dispose in order', () => {
    const host = new EditorPluginHost()
    const events: string[] = []
    const plugin: EditorPlugin = {
      name: 'lifecycle-plugin',
      install: () => {
        events.push('install')
        return { dispose: () => events.push('install-dispose') }
      },
      activate: () => {
        events.push('activate')
        return { dispose: () => events.push('activate-dispose') }
      },
      update: (_context, state) => {
        events.push(`update:${state.active}:${state.managed}:${state.manual}`)
      },
      deactivate: () => events.push('deactivate'),
      dispose: () => events.push('dispose'),
    }

    host.setPlugins([plugin])
    host.setPlugins([])
    host.dispose()

    expect(events).toEqual([
      'install',
      'activate',
      'update:true:true:false',
      'update:true:false:false',
      'deactivate',
      'activate-dispose',
      'dispose',
      'install-dispose',
    ])
  })

  test('updates lifecycle state while managed and manual ownership overlap', () => {
    const host = new EditorPluginHost()
    const states: string[] = []
    const plugin: EditorPlugin = {
      name: 'owned-plugin',
      activate: () => undefined,
      update: (_context, state) => {
        states.push(`${state.active}:${state.managed}:${state.manual}`)
      },
    }

    const lease = host.addPlugin(plugin)
    host.setPlugins([plugin])
    lease.dispose()
    host.setPlugins([])
    host.dispose()

    expect(states).toEqual([
      'true:false:true',
      'true:true:true',
      'true:true:false',
      'true:false:false',
    ])
  })

  test('late view contributions receive an initial document update', () => {
    const editor = createEditor()
    const updates: string[] = []
    const plugin: EditorPlugin = {
      activate: (context) =>
        context.registerViewContribution({
          createContribution: () => ({
            update: (_snapshot, kind) => updates.push(kind),
            dispose: () => undefined,
          }),
        }),
    }

    editor.addPlugin(plugin)

    expect(updates).toEqual(['document'])
    editor.dispose()
  })

  test('late gutter contributions attach and dispose mounted cells', () => {
    const editor = createEditor()
    const disposedCells: HTMLElement[] = []
    const contribution: EditorGutterContribution = {
      id: 'test-gutter',
      createCell: (document) => document.createElement('span'),
      width: () => 8,
      updateCell: () => undefined,
      disposeCell: (element) => disposedCells.push(element),
    }
    const plugin: EditorPlugin = {
      activate: (context) => context.registerGutterContribution(contribution),
    }

    const lease = editor.addPlugin(plugin)
    syncEditorViewport(editor, 320, 120)
    const cells = findGutterCells('test-gutter')

    expect(cells.length).toBeGreaterThan(0)

    lease.dispose()

    expect(disposedCells).toHaveLength(cells.length)
    expect(findGutterCells('test-gutter')).toHaveLength(0)
    editor.dispose()
  })

  test('registered loggers receive structured editor events and lifecycle summary', () => {
    const events: EditorLogEvent[] = []
    const editor = createEditor({
      plugins: [createEditorLoggingPlugin((event) => events.push(event))],
    })

    editor.edit({ from: 0, to: 0, text: 'x' })
    editor.dispatchCommand('selectAll')
    editor.dispose()

    expect(events.some((event) => event.action === 'editor.lifecycle.summary')).toBe(true)
    expect(events.some((event) => event.action === 'editor.plugin.activated')).toBe(false)
    expect(events.some((event) => event.action === 'editor.command.dispatched')).toBe(true)

    const summary = events.find((event) => event.action === 'editor.lifecycle.summary')
    expect(summary).toMatchObject({
      level: 'info',
      plugin: {
        activatedCount: 1,
        disposedCount: 1,
      },
      source: 'editor',
    })

    const change = events.find(
      (event) =>
        event.action === 'editor.session.changed' &&
        (event.change as { kind?: string } | undefined)?.kind === 'edit',
    )
    expect(change).toMatchObject({
      level: 'info',
      source: 'editor',
      editor: {
        documentId: null,
        languageId: null,
      },
    })
  })

  test('contains plugin activation failure and cleans partial registrations', () => {
    const events: EditorLogEvent[] = []
    const editor = createEditor({
      plugins: [createEditorLoggingPlugin((event) => events.push(event))],
    })
    const contribution: EditorGutterContribution = {
      id: 'failing-gutter',
      createCell: (document) => document.createElement('span'),
      width: () => 8,
      updateCell: () => undefined,
    }
    const plugin: EditorPlugin = {
      name: 'failing-plugin',
      activate: (context) => {
        context.registerGutterContribution(contribution)
        throw new Error('activation failed')
      },
    }

    const lease = editor.addPlugin(plugin)

    expect(findGutterCells('failing-gutter')).toHaveLength(0)
    expect(editor.removePlugin(plugin)).toBe(false)
    expect(events.some((event) => event.action === 'editor.plugin.activation_failed')).toBe(true)

    lease.dispose()
    editor.dispose()
  })

  test('rejects duplicate capability registrations without removing the owner', () => {
    const token = createEditorCapabilityToken<{ readonly owner: string }>('test.capability')
    const events: EditorLogEvent[] = []
    const editor = createEditor({
      plugins: [createEditorLoggingPlugin((event) => events.push(event))],
    })
    const owner = createCapabilityPlugin(token, 'owner')
    const conflictingToken = createEditorCapabilityToken<{ readonly owner: string }>(
      'test.capability',
    )
    const conflicting = createCapabilityPlugin(conflictingToken, 'conflicting')

    editor.addPlugin(owner)
    editor.addPlugin(conflicting)

    expect(readCapabilityOwner(editor, token)).toBe('owner')
    expect(events.some((event) => event.action === 'editor.contribution.factory_failed')).toBe(true)

    editor.dispose()
  })

  test('rejects duplicate command handlers without removing the owner', () => {
    const events: EditorLogEvent[] = []
    const editor = createEditor({
      plugins: [createEditorLoggingPlugin((event) => events.push(event))],
    })
    const owner = createCommandPlugin('owner')
    const conflicting = createCommandPlugin('conflicting')

    editor.addPlugin(owner.plugin)
    editor.addPlugin(conflicting.plugin)

    expect(editor.dispatchCommand('goToDefinition')).toBe(true)
    expect(owner.calls).toBe(1)
    expect(conflicting.calls).toBe(0)
    expect(events.some((event) => event.action === 'editor.contribution.factory_failed')).toBe(true)

    editor.dispose()
  })

  test('rejects duplicate gutter ids without removing the owner', () => {
    const events: EditorLogEvent[] = []
    const editor = createEditor({
      plugins: [createEditorLoggingPlugin((event) => events.push(event))],
    })
    const owner = createGutterPlugin('duplicate-gutter')
    const conflicting = createGutterPlugin('duplicate-gutter')

    editor.addPlugin(owner)
    editor.addPlugin(conflicting)
    syncEditorViewport(editor, 320, 120)

    expect(findGutterCells('duplicate-gutter').length).toBeGreaterThan(0)
    expect(events.some((event) => event.action === 'editor.plugin.activation_failed')).toBe(true)

    editor.dispose()
  })

  test('rejects duplicate block provider registration without removing the owner', () => {
    const host = new EditorPluginHost()
    const failures: string[] = []
    const provider: EditorBlockProvider = { getBlocks: () => [] }
    const owner: EditorPlugin = {
      name: 'block-owner',
      activate: (context) => context.registerBlockProvider(provider),
    }
    const conflicting: EditorPlugin = {
      name: 'block-conflict',
      activate: (context) => context.registerBlockProvider(provider),
    }
    host.setEvents({
      onPluginActivationFailed: (name) => failures.push(name),
    })

    const ownerLease = host.addPlugin(owner)
    const conflictingLease = host.addPlugin(conflicting)

    expect(host.getBlockProviders()).toEqual([provider])
    expect(failures).toEqual(['block-conflict'])

    conflictingLease.dispose()
    ownerLease.dispose()
    host.dispose()
  })

  test('rejects duplicate decoration source ownership without removing the owner', () => {
    const events: EditorLogEvent[] = []
    const editor = createEditor({
      plugins: [createEditorLoggingPlugin((event) => events.push(event))],
    })
    const owner = createRowDecorationPlugin('decoration-owner', 'shared-source', 'owner-row')
    const conflicting = createRowDecorationPlugin(
      'decoration-conflict',
      'shared-source',
      'conflicting-row',
    )

    editor.addPlugin(owner)
    editor.addPlugin(conflicting)

    const firstRow = findVirtualRow(0)
    expect(firstRow?.className).toContain('owner-row')
    expect(firstRow?.className).not.toContain('conflicting-row')
    expect(events.some((event) => event.action === 'editor.contribution.factory_failed')).toBe(true)

    editor.dispose()
  })

  test('contains contribution factory failures after activation', () => {
    const events: EditorLogEvent[] = []
    const editor = createEditor({
      plugins: [createEditorLoggingPlugin((event) => events.push(event))],
    })
    const plugin: EditorPlugin = {
      name: 'factory-failure',
      activate: (context) =>
        context.registerViewContribution({
          createContribution: () => {
            throw new Error('factory failed')
          },
        }),
    }

    const lease = editor.addPlugin(plugin)

    expect(events.some((event) => event.action === 'editor.plugin.activation_failed')).toBe(false)
    expect(events.some((event) => event.action === 'editor.contribution.factory_failed')).toBe(true)

    lease.dispose()
    editor.dispose()
  })

  test('contains contribution update failures after activation', () => {
    const events: EditorLogEvent[] = []
    const editor = createEditor({
      plugins: [createEditorLoggingPlugin((event) => events.push(event))],
    })
    let updates = 0
    let disposals = 0
    const plugin: EditorPlugin = {
      name: 'update-failure',
      activate: (context) =>
        context.registerViewContribution({
          createContribution: () => ({
            update: (_snapshot, kind) => {
              updates += 1
              if (kind !== 'document') throw new Error('update failed')
            },
            dispose: () => {
              disposals += 1
            },
          }),
        }),
    }

    editor.addPlugin(plugin)
    editor.edit({ from: 0, to: 0, text: 'x' })
    editor.edit({ from: 0, to: 0, text: 'y' })

    expect(events.some((event) => event.action === 'editor.contribution.update_failed')).toBe(true)
    expect(disposals).toBe(1)
    expect(updates).toBe(2)

    editor.dispose()
  })

  test('contains contribution disposal failures after activation', () => {
    const events: EditorLogEvent[] = []
    const editor = createEditor({
      plugins: [createEditorLoggingPlugin((event) => events.push(event))],
    })
    const plugin: EditorPlugin = {
      name: 'dispose-failure',
      activate: (context) =>
        context.registerCommandContribution({
          createContribution: () => ({
            dispose: () => {
              throw new Error('dispose failed')
            },
          }),
        }),
    }

    const lease = editor.addPlugin(plugin)
    lease.dispose()

    expect(events.some((event) => event.action === 'editor.contribution.dispose_failed')).toBe(true)

    editor.dispose()
  })

  test('registers commands through the narrow command contribution API', () => {
    const editor = createEditor()
    let calls = 0
    const plugin: EditorPlugin = {
      activate: (context) =>
        context.registerCommandContribution({
          createContribution: (commandContext) => {
            const registration = commandContext.registerCommand('goToDefinition', () => {
              calls += 1
              return true
            })
            return { dispose: () => registration.dispose() }
          },
        }),
    }

    const lease = editor.addPlugin(plugin)

    expect(editor.dispatchCommand('goToDefinition')).toBe(true)
    expect(calls).toBe(1)

    lease.dispose()

    expect(editor.dispatchCommand('goToDefinition')).toBe(false)
    expect(calls).toBe(1)

    editor.dispose()
  })

  test('makes contribution registration disposal idempotent', () => {
    const host = new EditorPluginHost()
    let registration: EditorDisposable | null = null
    const plugin: EditorPlugin = {
      activate: (context) => {
        registration = context.registerSyntaxProvider({ createSession: () => null })
        return registration
      },
    }

    const lease = host.addPlugin(plugin)
    const activeRegistration = requireDisposable(registration)

    expect(host.hasSyntaxProviders()).toBe(true)
    activeRegistration.dispose()
    activeRegistration.dispose()
    expect(host.hasSyntaxProviders()).toBe(false)

    lease.dispose()
    host.dispose()
  })
})

function createEditor(options: EditorOptions = {}): Editor {
  const container = document.createElement('div')
  mockEditorViewport(container, 320, 120)
  document.body.appendChild(container)
  const editor = new Editor(container, { defaultText: 'one\ntwo', ...options })
  mockEditorViewport(editorElement(editor), 320, 120)
  syncEditorViewport(editor, 320, 120)
  editor.setScrollPosition({ top: 0, left: 0 })
  return editor
}

function editorElement(editor: Editor): HTMLElement {
  return (editor as unknown as { readonly el: HTMLElement }).el
}

function syncEditorViewport(editor: Editor, width: number, height: number): void {
  const internals = editor as unknown as {
    readonly view: {
      setScrollMetrics(scrollTop: number, viewportHeight: number, viewportWidth: number): void
    }
  }
  internals.view.setScrollMetrics(0, height, width)
}

function mockEditorViewport(element: HTMLElement, width: number, height: number): void {
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: height })
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: width })
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: height })
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      bottom: height,
      height,
      left: 0,
      right: width,
      top: 0,
      width,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  })
}

function createLifecyclePlugin(): {
  readonly plugin: EditorPlugin
  readonly activations: number
  readonly disposals: number
} {
  const lifecycle = {
    activations: 0,
    disposals: 0,
  }
  const plugin: EditorPlugin = {
    activate: () => {
      lifecycle.activations += 1
      return {
        dispose: () => {
          lifecycle.disposals += 1
        },
      }
    },
  }

  return {
    plugin,
    get activations() {
      return lifecycle.activations
    },
    get disposals() {
      return lifecycle.disposals
    },
  }
}

function createContextCapturePlugin(contexts: EditorPluginContext[]): EditorPlugin {
  return {
    activate: (context) => {
      contexts.push(context)
    },
  }
}

function createCapabilityPlugin(
  token: EditorCapabilityToken<{ readonly owner: string }>,
  owner: string,
): EditorPlugin {
  return {
    name: owner,
    activate: (context) =>
      context.registerCapabilityContribution({
        createContribution: (capabilityContext) => {
          const registration = capabilityContext.registerFeature(token, { owner })
          return { dispose: () => registration.dispose() }
        },
      }),
  }
}

function readCapabilityOwner(
  editor: Editor,
  token: EditorCapabilityToken<{ readonly owner: string }>,
): string | null {
  let owner: string | null = null
  const plugin: EditorPlugin = {
    activate: (context) =>
      context.registerViewContribution({
        createContribution: (viewContext) => {
          owner = viewContext.getFeature?.(token)?.owner ?? null
          return { update: () => undefined, dispose: () => undefined }
        },
      }),
  }

  const lease = editor.addPlugin(plugin)
  lease.dispose()
  return owner
}

function createCommandPlugin(name: string): {
  readonly plugin: EditorPlugin
  readonly calls: number
} {
  const state = { calls: 0 }
  return {
    plugin: {
      name,
      activate: (context) =>
        context.registerCommandContribution({
          createContribution: (commandContext) => {
            const registration = commandContext.registerCommand('goToDefinition', () => {
              state.calls += 1
              return true
            })
            return { dispose: () => registration.dispose() }
          },
        }),
    },
    get calls() {
      return state.calls
    },
  }
}

function createGutterPlugin(id: string): EditorPlugin {
  return {
    name: id,
    activate: (context) => context.registerGutterContribution(createGutterContribution(id)),
  }
}

function createGutterContribution(id: string): EditorGutterContribution {
  return {
    id,
    createCell: (document) => document.createElement('span'),
    width: () => 8,
    updateCell: () => undefined,
  }
}

function createRowDecorationPlugin(
  name: string,
  sourceId: string,
  className: string,
): EditorPlugin {
  return {
    name,
    activate: (context) =>
      context.registerDecorationContribution({
        createContribution: (decorationContext) => {
          decorationContext.setRowDecorations(sourceId, new Map([[0, { className }]]))
          return {
            dispose: () => decorationContext.clearRowDecorations(sourceId),
          }
        },
      }),
  }
}

function requireDisposable(disposable: EditorDisposable | null): EditorDisposable {
  if (!disposable) throw new Error('missing disposable')
  return disposable
}

function findVirtualRow(index: number): HTMLElement | null {
  return document.body.querySelector(`[data-editor-virtual-row="${index}"]`)
}

function findGutterCells(id: string): HTMLElement[] {
  const matches: HTMLElement[] = []
  const elements = document.body.getElementsByTagName('*')
  for (const element of elements) {
    if (element instanceof HTMLElement && element.dataset.editorGutterContribution === id)
      matches.push(element)
  }

  return matches
}

function installDom(): () => void {
  const previous = captureDomGlobals()
  const window = new Window() as TestWindow
  Object.assign(window, { SyntaxError })

  Object.assign(globalThis, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    HTMLDivElement: window.HTMLDivElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Node: window.Node,
    DOMRect: window.DOMRect,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
  })
  Object.defineProperty(globalThis, 'Highlight', {
    configurable: true,
    value: class Highlight {
      constructor(..._ranges: AbstractRange[]) {}
    },
  })

  return () => restoreDomGlobals(previous)
}

function captureDomGlobals(): Record<string, unknown> {
  return Object.fromEntries(DOM_GLOBALS.map((key) => [key, globalThis[key]]))
}

function restoreDomGlobals(previous: Record<string, unknown>): void {
  for (const key of DOM_GLOBALS) restoreDomGlobal(key, previous[key])
}

function restoreDomGlobal(key: string, value: unknown): void {
  if (value === undefined) {
    Reflect.deleteProperty(globalThis, key)
    return
  }

  Object.defineProperty(globalThis, key, {
    configurable: true,
    value,
  })
}

const DOM_GLOBALS = [
  'window',
  'document',
  'HTMLElement',
  'HTMLDivElement',
  'HTMLTextAreaElement',
  'Node',
  'DOMRect',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'Highlight',
] as const
