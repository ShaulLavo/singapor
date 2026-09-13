import type { DocumentSyncSegment } from '@singapore-editor/core/document'
import type { EditorViewSnapshot } from '@singapore-editor/core/extensions'

const TEST_DOCUMENT_SYNC_SEGMENT = Object.freeze({}) as DocumentSyncSegment
const keyedSegments = new Map<string, DocumentSyncSegment>()

export function documentSyncSnapshotFields(
  textVersion: number,
  segmentKey?: string,
): Pick<EditorViewSnapshot, 'changesSinceDocumentSyncPoint' | 'documentSyncPoint'> {
  const segment = segmentKey ? segmentForKey(segmentKey) : TEST_DOCUMENT_SYNC_SEGMENT
  return {
    changesSinceDocumentSyncPoint: () => null,
    documentSyncPoint: {
      revision: textVersion,
      segment,
      textVersion,
    },
  }
}

export function viewSnapshotStructuralFields(): Pick<
  EditorViewSnapshot,
  | 'gutterLayout'
  | 'gutterWidth'
  | 'initialHighlightStatus'
  | 'syntaxStatus'
  | 'paintLayers'
  | 'toJSON'
  | 'toVisibleSnapshot'
> {
  return {
    gutterLayout: { fixedWidth: 0, lanes: [] },
    gutterWidth: 0,
    initialHighlightStatus: 'painted',
    syntaxStatus: 'ready',
    paintLayers: [],
    toJSON() {
      throw new Error('not used by this fixture')
    },
    toVisibleSnapshot() {
      return null
    },
  }
}

function segmentForKey(key: string): DocumentSyncSegment {
  const current = keyedSegments.get(key)
  if (current) return current

  const created = Object.freeze({}) as DocumentSyncSegment
  keyedSegments.set(key, created)
  return created
}
