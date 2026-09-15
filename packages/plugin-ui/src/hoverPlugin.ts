import type {
  EditorPlugin,
  EditorPluginContext,
  EditorViewContributionContext,
} from '@singapore-editor/core/extensions'

import { createHoverController, type HoverController } from './hoverController'

export type HoverPluginOptions = {
  readonly name?: string
  readonly classNamespace?: string
  readonly markdownCodeBackground?: boolean
  readonly themeVariables?: readonly string[]
}

type LiveHover = {
  readonly context: EditorViewContributionContext
  readonly controller: HoverController
}

const controllers = new WeakMap<HTMLElement, HoverController>()

/**
 * The hover controller a view's scroll element belongs to, for a plugin that has to hide the hover
 * when its own surface opens. Null before the hover has activated on that view.
 */
export function hoverControllerFor(scrollElement: HTMLElement): HoverController | null {
  return controllers.get(scrollElement) ?? null
}

/** Whether an event target sits inside any floating editor surface. */
export function isInsideEditorPopup(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return target.closest('[data-editor-popup]') !== null
}

/**
 * The one hover per view and the command that summons it from the caret. Participants register
 * through EDITOR_HOVER_PARTICIPANT; this plugin has no content of its own. An editor installs it by
 * itself once a participant registers (see hoverToken.ts); a test with a hand-made view context
 * installs it directly.
 */
export function createHoverPlugin(options: HoverPluginOptions = {}): EditorPlugin {
  return {
    name: options.name ?? 'editor.hover',
    activate: (plugin) => activateHover(plugin, options),
  }
}

function activateHover(plugin: EditorPluginContext, options: HoverPluginOptions) {
  // Per activation, so the command only walks the views of the editor that dispatched it.
  const live = new Set<LiveHover>()
  return [
    plugin.registerViewContribution({
      createContribution: (context) => {
        const controller = createHoverController({ context, ...options })
        const entry: LiveHover = { context, controller }
        live.add(entry)
        controllers.set(context.scrollElement, controller)
        return {
          update: (snapshot, kind) => controller.update(snapshot, kind),
          dispose: () => {
            live.delete(entry)
            if (controllers.get(context.scrollElement) === controller) {
              controllers.delete(context.scrollElement)
            }
            controller.dispose()
          },
        }
      },
    }),
    plugin.registerCommandContribution({
      createContribution: (commands) =>
        commands.registerCommand('editor.action.showHover', () => {
          for (const { context, controller } of live) {
            const selection = context.getSnapshot().selections[0]
            if (!selection) continue
            if (controller.showAtOffset(selection.headOffset, { focus: true })) return true
          }
          return false
        }),
    }),
  ]
}
