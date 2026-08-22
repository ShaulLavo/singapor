import { expect, it } from 'vitest'
import '../src/style.css'

import { VirtualizedTextView } from '../src/virtualization'
import {
  getRowGeometrySweepCount,
  resetRowGeometrySweepCount,
} from '../src/virtualization/virtualizedTextViewGeometry'

type Mounted = {
  readonly container: HTMLElement
  readonly view: VirtualizedTextView
  readonly mountMs: number
  dispose(): void
}

it('keeps 6,000-character BiDi operations within 5x an equal-length Latin control', () => {
  resetRowGeometrySweepCount()
  const result = measureLength(6_000)
  const measurements = JSON.stringify(result)
  expect(result.mountRatio, measurements).toBeLessThan(5)
  expect(result.clickRatio, measurements).toBeLessThan(5)
  expect(result.dragRatio, measurements).toBeLessThan(5)
  expect(getRowGeometrySweepCount()).toBe(0)
})

type OperationRatios = {
  readonly length: number
  readonly mountLatinMs: number
  readonly mountRtlMs: number
  readonly mountRatio: number
  readonly clickLatinMs: number
  readonly clickRtlMs: number
  readonly clickRatio: number
  readonly dragLatinMs: number
  readonly dragRtlMs: number
  readonly dragRatio: number
}

function measureLength(length: number): OperationRatios {
  const latinText = 'x'.repeat(length)
  const rtlText = 'א'.repeat(length)
  mountMeasured(latinText).dispose()
  mountMeasured(rtlText).dispose()

  const latinMounts: number[] = []
  const rtlMounts: number[] = []
  for (let sample = 0; sample < 7; sample += 1) {
    // Average repeated full mount operations within each sample. A single mount is sub-millisecond
    // on fast runners, where scheduler jitter can otherwise dominate the same-run control ratio.
    if (sample % 2 === 0) {
      latinMounts.push(timeMounts(latinText, 5))
      rtlMounts.push(timeMounts(rtlText, 5))
      continue
    }

    rtlMounts.push(timeMounts(rtlText, 5))
    latinMounts.push(timeMounts(latinText, 5))
  }

  const latin = mountMeasured(latinText)
  const rtl = mountMeasured(rtlText)
  // Batch independent single-click operations so sub-millisecond timer noise cannot dominate the
  // ratio. The drag timer covers the complete hit-test, selection-update, and paint path.
  const latinClick = timeClicks(latin, 100)
  const rtlClick = timeClicks(rtl, 100)
  const latinDrag = timeDrag(latin, 200)
  const rtlDrag = timeDrag(rtl, 200)
  const latinMount = median(latinMounts)
  const rtlMount = median(rtlMounts)
  const result = {
    length,
    mountLatinMs: round(latinMount),
    mountRtlMs: round(rtlMount),
    mountRatio: round(rtlMount / latinMount),
    clickLatinMs: round(latinClick),
    clickRtlMs: round(rtlClick),
    clickRatio: round(rtlClick / latinClick),
    dragLatinMs: round(latinDrag),
    dragRtlMs: round(rtlDrag),
    dragRatio: round(rtlDrag / latinDrag),
  }
  latin.dispose()
  rtl.dispose()
  return result
}

function timeMounts(text: string, count: number): number {
  let elapsed = 0
  for (let index = 0; index < count; index += 1) {
    const mounted = mountMeasured(text)
    elapsed += mounted.mountMs
    mounted.dispose()
  }
  return elapsed / count
}

function mountMeasured(text: string): Mounted {
  const container = document.createElement('div')
  container.style.font = '14px monospace'
  container.style.height = '20px'
  container.style.width = '600px'
  document.body.append(container)
  const start = performance.now()
  const view = new VirtualizedTextView(container, {
    rowHeight: 20,
    overscan: 0,
    longLineChunkThreshold: text.length + 1,
  })
  view.setText(text)
  view.setScrollMetrics(0, 20, 600)
  const mountMs = performance.now() - start
  return {
    container,
    view,
    mountMs,
    dispose: () => {
      view.dispose()
      container.remove()
    },
  }
}

function timeClicks(mounted: Mounted, count: number): number {
  const row = mounted.view.getState().mountedRows[0]!
  const rect = row.element.getBoundingClientRect()
  const start = performance.now()
  for (let index = 0; index < count; index += 1) {
    const x = rect.left + 1 + ((index * 2.75) % Math.max(2, rect.width - 2))
    mounted.view.textOffsetFromPoint(x, rect.top + rect.height / 2)
  }
  return performance.now() - start
}

function timeDrag(mounted: Mounted, count: number): number {
  const row = mounted.view.getState().mountedRows[0]!
  const rect = row.element.getBoundingClientRect()
  const y = rect.top + rect.height / 2
  const anchor = mounted.view.textOffsetFromPoint(rect.left + rect.width - 1, y) ?? 0
  const start = performance.now()
  for (let index = 0; index < count; index += 1) {
    const x = rect.left + 1 + ((index * 2.75) % Math.max(2, rect.width - 2))
    const head = mounted.view.textOffsetFromPoint(x, y)
    if (head === null) continue
    mounted.view.setSelection(anchor, head)
  }
  return performance.now() - start
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function median(values: readonly number[]): number {
  const sorted = values.toSorted((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]!
}
