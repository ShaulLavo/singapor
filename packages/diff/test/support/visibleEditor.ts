import { Editor } from '@singapor/core/editor'
import { EditorSecondaryTextView } from '@singapor/core/secondary-views'

export function createVisibleEditor(...args: ConstructorParameters<typeof Editor>): Editor {
  const editor = new Editor(...args)
  const view: unknown = Reflect.get(editor, 'view')
  // happy-dom has no layout, so deliver the first visible viewport measurement explicitly.
  if (view instanceof EditorSecondaryTextView) view.setScrollMetrics(0, 240, 640)
  return editor
}
