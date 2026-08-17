import { measureWhitespaceDotGlyph, type WhitespaceDotGlyph } from './browserMetrics'
import { setStyleValue } from './virtualizedTextViewHelpers'
import { isDocumentTextDisplayRow } from '../displayTransforms'
import { offsetToX } from './virtualizedTextViewGeometry'
import type {
  VirtualizedStoredSelection,
  VirtualizedTextViewInternal,
} from './virtualizedTextViewInternals'
import type {
  HiddenCharactersMode,
  MountedVirtualizedTextRow,
  VirtualizedTextChunk,
} from './virtualizedTextViewTypes'
import { rowOffsetForLocalIndex } from './virtualizedTextViewInlineMapping'

type HiddenCharacterKind = 'space' | 'tab'

/** Everything an element needs, so building one costs no measurement of any kind. */
type HiddenCharacterMarker = {
  readonly kind: HiddenCharacterKind
  readonly offset: number
  readonly left: number
  readonly width: number
  readonly glyph: string
}

/** Both -1 on a row with nothing but whitespace, which every index then falls outside. */
type NonWhitespaceBounds = {
  readonly first: number
  readonly last: number
}

/**
 * State every row in one pass shares. The dot glyph costs a measurement to resolve, so it waits for
 * the first row that rebuilds its markers — a pass that changes nothing must not touch the font.
 */
type HiddenCharacterPass = {
  readonly mode: HiddenCharactersMode
  readonly selectionKey: string
  spaceGlyph: WhitespaceDotGlyph | null
}

type HiddenCharacterRowContext = {
  readonly view: VirtualizedTextViewInternal
  readonly row: MountedVirtualizedTextRow
  readonly pass: HiddenCharacterPass
  readonly bounds: NonWhitespaceBounds
}

/** Null markers mean the row's inputs are unchanged and what it already draws still stands. */
type HiddenCharacterRowPlan = {
  readonly row: MountedVirtualizedTextRow
  readonly inputKey: string
  readonly markers: readonly HiddenCharacterMarker[] | null
}

/**
 * What a row's markers were last built from. Building them reads the row's geometry twice per
 * whitespace character, which on an indented file is hundreds of lookups per frame to usually
 * conclude that nothing moved — so the inputs are compared first and the row is left alone. The
 * geometry object stands in for every metric that shifts a column, because it is the thing that
 * gets retired when one of them changes.
 */
type HiddenCharacterInputs = {
  readonly key: string
  readonly geometry: unknown
}

const DEFAULT_HIDDEN_CHARACTERS: HiddenCharactersMode = 'show-on-selection'
const HIDDEN_CHARACTER_MODES: readonly HiddenCharactersMode[] = [
  'hidden',
  'show',
  'show-on-selection',
  'boundary',
  'trailing',
]
const TAB_GLYPH = '→'
const hiddenCharacterInputs = new WeakMap<HTMLElement, HiddenCharacterInputs>()

export function normalizeHiddenCharactersMode(
  mode: HiddenCharactersMode | undefined,
): HiddenCharactersMode {
  if (mode && HIDDEN_CHARACTER_MODES.includes(mode)) return mode
  return DEFAULT_HIDDEN_CHARACTERS
}

/**
 * Every row is measured before any row is drawn. Where a column sits is read out of the layout, and
 * drawing into a row dirties that layout, so alternating the two per row makes each row pay to
 * settle the one before it. Splitting them means the pass settles at most once.
 */
export function renderHiddenCharacters(view: VirtualizedTextViewInternal): void {
  const pass: HiddenCharacterPass = {
    mode: view.hiddenCharacters,
    selectionKey: hiddenCharacterSelectionKey(view),
    spaceGlyph: null,
  }
  const plans: HiddenCharacterRowPlan[] = []
  for (const row of view.rowElements.values()) {
    plans.push(planHiddenCharactersForRow(view, row, pass))
  }

  for (const plan of plans) drawHiddenCharactersForRow(plan)
}

function planHiddenCharactersForRow(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  pass: HiddenCharacterPass,
): HiddenCharacterRowPlan {
  const inputKey = hiddenCharacterInputKey(row, pass)
  const previous = hiddenCharacterInputs.get(row.element)
  if (previous?.key === inputKey && previous.geometry === row.geometryCache) {
    return { row, inputKey, markers: null }
  }

  return { row, inputKey, markers: hiddenCharacterMarkersForRow(view, row, pass) }
}

function drawHiddenCharactersForRow(plan: HiddenCharacterRowPlan): void {
  const { row, markers } = plan
  if (!markers) {
    if (row.hiddenCharactersKey.length > 0) attachHiddenCharacterLayer(row)
    return
  }

  if (markers.length === 0) {
    clearHiddenCharactersForRow(row)
    rememberHiddenCharacterInputs(row, plan.inputKey)
    return
  }

  const markerKey = hiddenCharacterMarkerKey(markers)
  if (row.hiddenCharactersKey !== markerKey) {
    setHiddenCharactersKey(row, markerKey)
    row.hiddenCharactersLayerElement.replaceChildren(
      ...markers.map((marker) => createHiddenCharacterMarker(row, marker)),
    )
  }

  rememberHiddenCharacterInputs(row, plan.inputKey)
  attachHiddenCharacterLayer(row)
}

/**
 * Everything outside the geometry that decides which characters get a marker: the text under the
 * row, the horizontal window of it that is mounted, the mode, and — only where the mode reads it —
 * the selection. The offset pins the row to a line, since a recycled row keeps its element.
 */
function hiddenCharacterInputKey(
  row: MountedVirtualizedTextRow,
  pass: HiddenCharacterPass,
): string {
  return [
    row.textRevision,
    row.startOffset,
    row.text.length,
    row.chunkKey,
    pass.mode,
    pass.selectionKey,
  ].join(':')
}

function hiddenCharacterSelectionKey(view: VirtualizedTextViewInternal): string {
  if (view.hiddenCharacters !== 'show-on-selection') return ''
  return view.selections.map((selection) => `${selection.start}-${selection.end}`).join(',')
}

function rememberHiddenCharacterInputs(row: MountedVirtualizedTextRow, key: string): void {
  hiddenCharacterInputs.set(row.element, { key, geometry: row.geometryCache })
}

function hiddenCharacterMarkersForRow(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  pass: HiddenCharacterPass,
): readonly HiddenCharacterMarker[] {
  if (pass.mode === 'hidden') return []
  if (row.kind !== 'text') return []
  if (row.source === 'injected') return []
  // What sits at the end of a wrapped segment is the middle of the line it was cut from, so a row
  // that carries on below has no trailing whitespace of its own to report.
  if (pass.mode === 'trailing' && rowContinuesBelow(view, row)) return []

  const context: HiddenCharacterRowContext = {
    view,
    row,
    pass,
    bounds: nonWhitespaceBounds(row.text),
  }
  const markers: HiddenCharacterMarker[] = []
  for (const chunk of row.chunks) {
    appendHiddenCharacterMarkersForChunk(markers, context, chunk)
  }

  return markers
}

function appendHiddenCharacterMarkersForChunk(
  markers: HiddenCharacterMarker[],
  context: HiddenCharacterRowContext,
  chunk: VirtualizedTextChunk,
): void {
  for (let index = chunk.localStart; index < chunk.localEnd; index += 1) {
    const char = context.row.text[index]!
    appendHiddenCharacterMarker(markers, context, char, index)
  }
}

function appendHiddenCharacterMarker(
  markers: HiddenCharacterMarker[],
  context: HiddenCharacterRowContext,
  char: string,
  localIndex: number,
): void {
  const kind = hiddenCharacterKind(char)
  if (!kind) return

  const { view, row } = context
  const offset = rowOffsetForLocalIndex(row, localIndex)
  if (!shouldShowHiddenCharacter(context, kind, localIndex, offset)) return

  const left = offsetToX(view, row, offset)
  const right = offsetToX(view, row, offset + 1)
  markers.push({
    kind,
    offset,
    left: Math.min(left, right),
    width: Math.abs(right - left),
    glyph: hiddenCharacterGlyph(context, kind),
  })
}

function hiddenCharacterKind(char: string): HiddenCharacterKind | null {
  if (char === ' ') return 'space'
  if (char === '\t') return 'tab'
  return null
}

function shouldShowHiddenCharacter(
  context: HiddenCharacterRowContext,
  kind: HiddenCharacterKind,
  localIndex: number,
  offset: number,
): boolean {
  const { mode } = context.pass
  if (mode === 'show') return true
  // A tab is an indentation decision wherever it sits, so the quieting of interior whitespace does
  // not extend to it.
  if (mode === 'boundary') return kind === 'tab' || isBoundarySpace(context, localIndex)
  if (mode === 'trailing') return localIndex > context.bounds.last
  if (mode !== 'show-on-selection') return false

  return context.view.selections.some((selection) => selectionContainsOffset(selection, offset))
}

function isBoundarySpace(context: HiddenCharacterRowContext, localIndex: number): boolean {
  const { first, last } = context.bounds
  if (localIndex < first || localIndex > last) return true

  // Inside the text a lone space is a word separator and marking it shreds prose; two or more in a
  // row are alignment, which is the thing worth seeing.
  const { text } = context.row
  return text[localIndex - 1] === ' ' || text[localIndex + 1] === ' '
}

function nonWhitespaceBounds(text: string): NonWhitespaceBounds {
  let first = -1
  let last = -1
  for (let index = 0; index < text.length; index += 1) {
    if (hiddenCharacterKind(text[index]!)) continue
    if (first === -1) first = index
    last = index
  }

  return { first, last }
}

function rowContinuesBelow(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
): boolean {
  const next = view.model.rows[row.index + 1]
  return isDocumentTextDisplayRow(next) && next.bufferRow === row.bufferRow
}

function selectionContainsOffset(selection: VirtualizedStoredSelection, offset: number): boolean {
  if (selection.start === selection.end) return false
  if (offset < selection.start) return false
  return offset < selection.end
}

function hiddenCharacterMarkerKey(markers: readonly HiddenCharacterMarker[]): string {
  return markers.map(hiddenCharacterMarkerKeyPart).join('|')
}

function hiddenCharacterMarkerKeyPart(marker: HiddenCharacterMarker): string {
  return `${marker.kind}:${marker.offset}:${marker.left}:${marker.width}`
}

function createHiddenCharacterMarker(
  row: MountedVirtualizedTextRow,
  marker: HiddenCharacterMarker,
): HTMLSpanElement {
  const element = row.element.ownerDocument.createElement('span')
  element.className = 'editor-virtualized-hidden-character-marker'
  element.dataset.editorHiddenCharacter = marker.kind
  element.dataset.editorHiddenCharacterOffset = String(marker.offset)
  element.textContent = marker.glyph
  setStyleValue(element, 'left', `${marker.left}px`)
  setStyleValue(element, 'width', `${marker.width}px`)
  return element
}

function hiddenCharacterGlyph(
  context: HiddenCharacterRowContext,
  kind: HiddenCharacterKind,
): string {
  if (kind === 'tab') return TAB_GLYPH

  const { pass } = context
  pass.spaceGlyph ??= measureWhitespaceDotGlyph(context.view.scrollElement)
  return pass.spaceGlyph
}

export function clearHiddenCharactersForRow(row: MountedVirtualizedTextRow): void {
  setHiddenCharactersKey(row, '')
  row.hiddenCharactersLayerElement.replaceChildren()
  row.hiddenCharactersLayerElement.remove()
}

function attachHiddenCharacterLayer(row: MountedVirtualizedTextRow): void {
  const layer = row.hiddenCharactersLayerElement
  if (layer.parentElement === row.element) return
  if (row.foldPlaceholderElement.parentElement === row.element) {
    row.element.insertBefore(layer, row.foldPlaceholderElement)
    return
  }

  row.element.appendChild(layer)
}

function setHiddenCharactersKey(row: MountedVirtualizedTextRow, key: string): void {
  const mutable = row as { hiddenCharactersKey: string }
  mutable.hiddenCharactersKey = key
}
