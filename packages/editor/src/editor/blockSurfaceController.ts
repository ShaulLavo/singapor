import type { BlockLane, BlockRow } from '../displayTransforms'
import type {
  EditorBlock,
  EditorBlockMountContext,
  EditorBlockProvider,
  EditorBlockProviderContext,
} from '../editorBlocks'
import type { EditorDisposable } from '../plugins'
import {
  addEditorBlockMeasurementKey,
  applyEditorBlockMeasurementBounds,
  clampEditorBlockMeasuredSize,
  createEditorBlockResizeObserver,
  disposableOnce,
  editorBlockSurfaceAnchorRange,
  editorBlockSurfaceAnchorRow,
  editorBlockSurfaceKey,
  editorBlockSurfaceLaneId,
  editorBlockSurfacePlacement,
  editorBlockSurfaceRowId,
  elementMeasuredEditorBlockSize,
  initialMeasuredEditorBlockSize,
  resizeObserverMeasuredSize,
  resolveEditorBlockSize,
  validEditorBlockId,
  type EditorBlockMeasurement,
  type ResolvedEditorBlockLaneSurface,
  type ResolvedEditorBlockSize,
  type ResolvedEditorBlockSurface,
} from './editorBlockSurfaces'

export type EditorBlockSurfaceControllerOptions = {
  getDocumentId(): string | null
  getLineCount(): number
  materializeFullText(): string
  applyBlockRows(rows: readonly BlockRow[]): void
  applyBlockLanes(lanes: readonly BlockLane[]): void
  focusEditor(): void
  setSelection(anchor: number, head: number): void
  notifyLayout(): void
}

export class EditorBlockSurfaceController {
  private readonly editorBlockSurfaces = new Map<string, ResolvedEditorBlockSurface>()
  private readonly editorBlockLaneSurfaces = new Map<string, ResolvedEditorBlockLaneSurface>()
  private readonly editorBlockMeasuredSizes = new Map<string, number>()
  private editorBlockRows: readonly BlockRow[] = []
  private editorBlockLanes: readonly BlockLane[] = []
  private editorBlockRevision = 0
  private editorBlockMeasureTimeout: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: EditorBlockSurfaceControllerOptions) {}

  sync(providers: readonly EditorBlockProvider[]): void {
    if (providers.length === 0) {
      this.clear()
      return
    }

    const context = this.createEditorBlockProviderContext()
    const resolution = this.resolveEditorBlockRows(providers, context)
    this.applyEditorBlockRows(
      resolution.rows,
      resolution.surfaces,
      resolution.lanes,
      resolution.laneSurfaces,
    )
  }

  clear(): void {
    if (
      this.editorBlockRows.length === 0 &&
      this.editorBlockLanes.length === 0 &&
      this.editorBlockMeasuredSizes.size === 0
    )
      return

    this.editorBlockRows = []
    this.editorBlockLanes = []
    this.editorBlockSurfaces.clear()
    this.editorBlockLaneSurfaces.clear()
    this.editorBlockMeasuredSizes.clear()
    this.options.applyBlockRows([])
    this.options.applyBlockLanes([])
  }

  dispose(): void {
    this.cancelScheduledEditorBlockMeasurementUpdate()
  }

  readonly mountRow = (
    container: HTMLElement,
    row: { readonly id: string },
  ): void | EditorDisposable => {
    const surface = this.editorBlockSurfaces.get(row.id)
    if (!surface) return undefined

    container.dataset.editorBlockSurface = surface.slot
    return this.mountEditorBlockSurface(container, surface, () =>
      surface.surface.mount(container, this.createEditorBlockMountContext(surface, container)),
    )
  }

  readonly mountLane = (
    container: HTMLElement,
    lane: { readonly id: string },
  ): void | EditorDisposable => {
    const surface = this.editorBlockLaneSurfaces.get(lane.id)
    if (!surface) return undefined

    container.dataset.editorBlockSurface = surface.slot
    return this.mountEditorBlockSurface(container, surface, () =>
      surface.surface.mount(container, this.createEditorBlockMountContext(surface, container)),
    )
  }

  private createEditorBlockProviderContext(): EditorBlockProviderContext {
    const text = this.deferredFullText()
    return {
      documentId: this.options.getDocumentId(),
      get text() {
        return text()
      },
      lineCount: this.options.getLineCount(),
    }
  }

  /**
   * The document string costs a walk of the whole buffer, and these contexts are
   * built far more often than they are read from: providers re-resolve on every
   * edit, surfaces re-mount on every recycle, and most of both anchor by row and
   * never look at the text. Charge the walk to the first reader, once.
   */
  private deferredFullText(): () => string {
    let text: string | null = null
    return () => (text ??= this.options.materializeFullText())
  }

  private resolveEditorBlockRows(
    providers: readonly EditorBlockProvider[],
    context: EditorBlockProviderContext,
  ): {
    readonly rows: readonly BlockRow[]
    readonly surfaces: ReadonlyMap<string, ResolvedEditorBlockSurface>
    readonly lanes: readonly BlockLane[]
    readonly laneSurfaces: ReadonlyMap<string, ResolvedEditorBlockLaneSurface>
  } {
    const revision = this.nextEditorBlockRevision()
    const rows: BlockRow[] = []
    const lanes: BlockLane[] = []
    const surfaces = new Map<string, ResolvedEditorBlockSurface>()
    const laneSurfaces = new Map<string, ResolvedEditorBlockLaneSurface>()

    providers.forEach((provider, providerIndex) => {
      this.appendProviderBlockSurfaces(
        provider,
        providerIndex,
        revision,
        context,
        rows,
        surfaces,
        lanes,
        laneSurfaces,
      )
    })

    return { rows, surfaces, lanes, laneSurfaces }
  }

  private nextEditorBlockRevision(): number {
    this.editorBlockRevision += 1
    return this.editorBlockRevision
  }

  private appendProviderBlockSurfaces(
    provider: EditorBlockProvider,
    providerIndex: number,
    revision: number,
    context: EditorBlockProviderContext,
    rows: BlockRow[],
    surfaces: Map<string, ResolvedEditorBlockSurface>,
    lanes: BlockLane[],
    laneSurfaces: Map<string, ResolvedEditorBlockLaneSurface>,
  ): void {
    for (const block of provider.getBlocks(context)) {
      this.appendEditorBlockSurfaceRow(
        block,
        'top',
        providerIndex,
        revision,
        context.lineCount,
        rows,
        surfaces,
      )
      this.appendEditorBlockSurfaceRow(
        block,
        'bottom',
        providerIndex,
        revision,
        context.lineCount,
        rows,
        surfaces,
      )
      this.appendEditorBlockSurfaceLane(
        block,
        'left',
        providerIndex,
        revision,
        context.lineCount,
        lanes,
        laneSurfaces,
      )
      this.appendEditorBlockSurfaceLane(
        block,
        'right',
        providerIndex,
        revision,
        context.lineCount,
        lanes,
        laneSurfaces,
      )
    }
  }

  private appendEditorBlockSurfaceRow(
    block: EditorBlock,
    slot: 'top' | 'bottom',
    providerIndex: number,
    revision: number,
    lineCount: number,
    rows: BlockRow[],
    surfaces: Map<string, ResolvedEditorBlockSurface>,
  ): void {
    const surface = block[slot]
    if (!surface) return
    if (!validEditorBlockId(block.id)) return

    const surfaceKey = editorBlockSurfaceKey(providerIndex, block.id, slot)
    const size = resolveEditorBlockSize(
      surface.height,
      surfaceKey,
      'height',
      this.editorBlockMeasuredSizes,
    )
    if (!size) return

    const rowId = editorBlockSurfaceRowId(revision, providerIndex, block.id, slot)
    const anchorBufferRow = editorBlockSurfaceAnchorRow(block.anchor, slot, lineCount)
    if (anchorBufferRow === null) return

    surfaces.set(rowId, { rowId, block, surface, slot, anchorBufferRow, size })
    rows.push({
      id: rowId,
      anchorBufferRow,
      placement: editorBlockSurfacePlacement(slot),
      heightRows: 1,
      heightPx: size.px,
      // Two providers anchoring to the same row would otherwise be ordered by
      // the lexical accident of their index inside the row id, which puts
      // provider 10 ahead of provider 9.
      ordinal: providerIndex,
      ...(size.measure ? { heightMeasured: true } : {}),
      ...(surface.hosting === 'hoisted' ? { hoistKey: surfaceKey } : {}),
    })
  }

  private appendEditorBlockSurfaceLane(
    block: EditorBlock,
    slot: 'left' | 'right',
    providerIndex: number,
    revision: number,
    lineCount: number,
    lanes: BlockLane[],
    laneSurfaces: Map<string, ResolvedEditorBlockLaneSurface>,
  ): void {
    const surface = block[slot]
    if (!surface) return
    if (!validEditorBlockId(block.id)) return

    const surfaceKey = editorBlockSurfaceKey(providerIndex, block.id, slot)
    const size = resolveEditorBlockSize(
      surface.width,
      surfaceKey,
      'width',
      this.editorBlockMeasuredSizes,
    )
    if (!size) return

    const range = editorBlockSurfaceAnchorRange(block.anchor, lineCount)
    if (range === null) return

    const laneId = editorBlockSurfaceLaneId(revision, providerIndex, block.id, slot)
    laneSurfaces.set(laneId, {
      laneId,
      block,
      surface,
      slot,
      startBufferRow: range.startRow,
      endBufferRow: range.endRow,
      size,
    })
    lanes.push({
      id: laneId,
      startBufferRow: range.startRow,
      endBufferRow: range.endRow,
      placement: slot,
      widthPx: size.px,
      ...(size.measure ? { widthMeasured: true } : {}),
    })
  }

  private applyEditorBlockRows(
    rows: readonly BlockRow[],
    surfaces: ReadonlyMap<string, ResolvedEditorBlockSurface>,
    lanes: readonly BlockLane[],
    laneSurfaces: ReadonlyMap<string, ResolvedEditorBlockLaneSurface>,
  ): void {
    this.editorBlockRows = rows
    this.editorBlockLanes = lanes
    this.editorBlockSurfaces.clear()
    this.editorBlockLaneSurfaces.clear()
    for (const [rowId, surface] of surfaces) this.editorBlockSurfaces.set(rowId, surface)
    for (const [laneId, surface] of laneSurfaces) this.editorBlockLaneSurfaces.set(laneId, surface)
    this.pruneMeasuredEditorBlockSizes(surfaces, laneSurfaces)
    this.options.applyBlockRows(rows)
    this.options.applyBlockLanes(lanes)
  }

  private createEditorBlockMountContext(
    surface: ResolvedEditorBlockSurface | ResolvedEditorBlockLaneSurface,
    container: HTMLElement,
  ): EditorBlockMountContext {
    const text = this.deferredFullText()
    return {
      blockId: surface.block.id,
      surface: surface.slot,
      anchor: surface.block.anchor,
      documentId: this.options.getDocumentId(),
      get text() {
        return text()
      },
      focusEditor: () => this.options.focusEditor(),
      setSelection: (anchor, head) => this.options.setSelection(anchor, head),
      requestMeasure: () => this.measureEditorBlockSurface(surface, container),
    }
  }

  private mountEditorBlockSurface(
    container: HTMLElement,
    surface: ResolvedEditorBlockSurface | ResolvedEditorBlockLaneSurface,
    mount: () => void | EditorDisposable,
  ): EditorDisposable {
    const measurement = surface.size.measure
    if (!measurement) {
      const disposable = mount()
      return disposableOnce(() => disposable?.dispose())
    }

    applyEditorBlockMeasurementBounds(container, measurement)
    const disposable = mount()

    const observer = createEditorBlockResizeObserver((entries) => {
      const measuredSize = resizeObserverMeasuredSize(entries, container, measurement.dimension)
      if (measuredSize === null) return

      this.setMeasuredEditorBlockSize(measurement, measuredSize)
    })
    observer?.observe(container)
    this.measureEditorBlockSurface(surface, container)

    return disposableOnce(() => {
      observer?.disconnect()
      disposable?.dispose()
    })
  }

  private measureEditorBlockSurface(
    surface: ResolvedEditorBlockSurface | ResolvedEditorBlockLaneSurface,
    container: HTMLElement,
  ): void {
    const measurement = surface.size.measure
    if (!measurement) return

    this.setMeasuredEditorBlockSize(
      measurement,
      elementMeasuredEditorBlockSize(container, measurement.dimension),
    )
  }

  private setMeasuredEditorBlockSize(
    measurement: EditorBlockMeasurement,
    measuredPx: number,
  ): void {
    const next = clampEditorBlockMeasuredSize(measuredPx, measurement)
    if (this.editorBlockMeasuredSizes.get(measurement.key) === next) return

    this.editorBlockMeasuredSizes.set(measurement.key, next)
    this.scheduleEditorBlockMeasurementUpdate()
  }

  private scheduleEditorBlockMeasurementUpdate(): void {
    if (this.editorBlockMeasureTimeout !== null) return

    this.editorBlockMeasureTimeout = setTimeout(() => {
      this.editorBlockMeasureTimeout = null
      this.applyMeasuredEditorBlockSizes()
    }, 0)
  }

  private cancelScheduledEditorBlockMeasurementUpdate(): void {
    if (this.editorBlockMeasureTimeout === null) return

    clearTimeout(this.editorBlockMeasureTimeout)
    this.editorBlockMeasureTimeout = null
  }

  private applyMeasuredEditorBlockSizes(): void {
    let changed = false
    const rows = this.editorBlockRows.map((row) => {
      const surface = this.editorBlockSurfaces.get(row.id)
      if (!surface) return row

      const heightPx = this.currentEditorBlockSizePx(surface.size)
      if (row.heightPx === heightPx) return row

      changed = true
      return { ...row, heightPx }
    })
    const lanes = this.editorBlockLanes.map((lane) => {
      const surface = this.editorBlockLaneSurfaces.get(lane.id)
      if (!surface) return lane

      const widthPx = this.currentEditorBlockSizePx(surface.size)
      if (lane.widthPx === widthPx) return lane

      changed = true
      return { ...lane, widthPx }
    })
    if (!changed) return

    this.editorBlockRows = rows
    this.editorBlockLanes = lanes
    this.options.applyBlockRows(rows)
    this.options.applyBlockLanes(lanes)
    this.options.notifyLayout()
  }

  private currentEditorBlockSizePx(size: ResolvedEditorBlockSize): number {
    const measurement = size.measure
    if (!measurement) return size.px

    return initialMeasuredEditorBlockSize(
      measurement,
      this.editorBlockMeasuredSizes.get(measurement.key),
    )
  }

  private pruneMeasuredEditorBlockSizes(
    surfaces: ReadonlyMap<string, ResolvedEditorBlockSurface>,
    laneSurfaces: ReadonlyMap<string, ResolvedEditorBlockLaneSurface>,
  ): void {
    const keys = new Set<string>()
    for (const surface of surfaces.values()) addEditorBlockMeasurementKey(keys, surface.size)
    for (const surface of laneSurfaces.values()) addEditorBlockMeasurementKey(keys, surface.size)

    for (const key of this.editorBlockMeasuredSizes.keys()) {
      if (keys.has(key)) continue
      this.editorBlockMeasuredSizes.delete(key)
    }
  }
}
