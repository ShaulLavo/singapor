import type { PieceTableSnapshot } from '@singapor/core/document'
import { createTreeSitterSourceDescriptor, type TreeSitterSourceDescriptor } from './source'

export type TreeSitterSourceChunkRetentionSnapshot = {
  readonly documents: number
  readonly sentChunks: number
  readonly sourceEpochs: number
}

export type TreeSitterSourceChunkRequest = {
  readonly documentId: string
  readonly source: TreeSitterSourceDescriptor
  readonly epoch: number
}

export class TreeSitterSourceChunkRetention {
  private readonly sentSourceChunkIds = new Map<string, Set<string>>()
  private readonly sourceDocumentEpochs = new Map<string, number>()

  public createDescriptor(
    documentId: string,
    snapshot: PieceTableSnapshot,
  ): TreeSitterSourceDescriptor {
    return createTreeSitterSourceDescriptor(snapshot, {
      sentChunkIds: this.sourceChunkIdsForDocument(documentId),
    })
  }

  public createRequest(
    documentId: string,
    source: TreeSitterSourceDescriptor,
  ): TreeSitterSourceChunkRequest {
    return {
      documentId,
      source,
      epoch: this.currentSourceEpoch(documentId),
    }
  }

  public markRequestSent(request: TreeSitterSourceChunkRequest | null): void {
    if (!request) return
    if (!this.canMarkRequestSent(request)) return

    const sent = this.sourceChunkIdsForDocument(request.documentId)
    for (const chunk of request.source.chunks) sent.add(chunk.chunkId)
  }

  public invalidateDocument(documentId: string): void {
    if (!this.hasDocumentState(documentId)) return

    this.sentSourceChunkIds.delete(documentId)
    this.sourceDocumentEpochs.set(documentId, this.currentSourceEpoch(documentId) + 1)
  }

  public clear(): void {
    this.sentSourceChunkIds.clear()
    this.sourceDocumentEpochs.clear()
  }

  public inspect(): TreeSitterSourceChunkRetentionSnapshot {
    return {
      documents: this.documentCount(),
      sentChunks: this.sentChunkCount(),
      sourceEpochs: this.sourceDocumentEpochs.size,
    }
  }

  private sourceChunkIdsForDocument(documentId: string): Set<string> {
    const existing = this.sentSourceChunkIds.get(documentId)
    if (existing) return existing

    const sent = new Set<string>()
    this.sentSourceChunkIds.set(documentId, sent)
    return sent
  }

  private canMarkRequestSent(request: TreeSitterSourceChunkRequest): boolean {
    return request.epoch === this.currentSourceEpoch(request.documentId)
  }

  private currentSourceEpoch(documentId: string): number {
    return this.sourceDocumentEpochs.get(documentId) ?? 0
  }

  private hasDocumentState(documentId: string): boolean {
    if (this.sentSourceChunkIds.has(documentId)) return true
    return this.sourceDocumentEpochs.has(documentId)
  }

  private documentCount(): number {
    return new Set([...this.sentSourceChunkIds.keys(), ...this.sourceDocumentEpochs.keys()]).size
  }

  private sentChunkCount(): number {
    let count = 0
    for (const chunks of this.sentSourceChunkIds.values()) count += chunks.size
    return count
  }
}
