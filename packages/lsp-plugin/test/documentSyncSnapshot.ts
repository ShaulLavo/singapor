import type { DocumentSyncSegment } from '@singapor/core/document'
import type { EditorViewSnapshot } from '@singapor/core/extensions'

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

function segmentForKey(key: string): DocumentSyncSegment {
  const current = keyedSegments.get(key)
  if (current) return current

  const created = Object.freeze({}) as DocumentSyncSegment
  keyedSegments.set(key, created)
  return created
}
