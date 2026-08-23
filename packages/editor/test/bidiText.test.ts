import { describe, expect, it } from 'vitest'

import { INVISIBLE_CODE_POINT_DATA } from '../src/unicodeHighlightData'
import {
  BIDI_CONTROL_CODE_POINTS,
  containsRTL,
  memoizedContainsRTL,
  rtlClassifierScanCount,
} from '../src/virtualization/virtualizedTextViewBidi'
import { rowMightContainRTL } from '../src/virtualization/virtualizedTextViewGeometry'
import type { VirtualizedTextViewInternal } from '../src/virtualization/virtualizedTextViewInternals'
import type { MountedVirtualizedTextRow } from '../src/virtualization/virtualizedTextViewTypes'

describe('BiDi row classifier', () => {
  it('recognizes RTL scripts and every layout-affecting bidi control', () => {
    expect(containsRTL('שלום')).toBe(true)
    expect(containsRTL('مرحبا')).toBe(true)
    expect(containsRTL('日本語')).toBe(false)
    expect(containsRTL('plain Latin')).toBe(false)
    for (const codePoint of BIDI_CONTROL_CODE_POINTS) {
      expect(containsRTL(`abc${String.fromCodePoint(codePoint)}def`)).toBe(true)
    }
  })

  it('keeps the eleven bidi controls aligned with the invisible-character table', () => {
    const invisible = new Set<number>(JSON.parse(INVISIBLE_CODE_POINT_DATA) as number[])
    for (const codePoint of BIDI_CONTROL_CODE_POINTS) expect(invisible.has(codePoint)).toBe(true)
  })

  it('scans a row once per text revision', () => {
    const view = { textRevision: 4 } as VirtualizedTextViewInternal
    const line = 'א'.repeat(6_000)

    expect(memoizedContainsRTL(view, line)).toBe(true)
    expect(memoizedContainsRTL(view, line)).toBe(true)
    expect(rtlClassifierScanCount(view)).toBe(1)

    ;(view as { textRevision: number }).textRevision = 5
    expect(memoizedContainsRTL(view, line)).toBe(true)
    expect(rtlClassifierScanCount(view)).toBe(1)
  })

  it('memoizes the absence proof for a 2MB ASCII line', () => {
    const view = { textRevision: 9 } as VirtualizedTextViewInternal
    const line = 'x'.repeat(2_000_000)

    expect(memoizedContainsRTL(view, line)).toBe(false)
    expect(memoizedContainsRTL(view, line)).toBe(false)
    expect(rtlClassifierScanCount(view)).toBe(1)
  })

  it('reuses the memo when caret geometry classifies an ASCII row', () => {
    const view = { textRevision: 11 } as VirtualizedTextViewInternal
    const row = { text: 'x'.repeat(2_000_000) } as MountedVirtualizedTextRow

    expect(rowMightContainRTL(view, row)).toBe(false)
    expect(rowMightContainRTL(view, row)).toBe(false)
    expect(rtlClassifierScanCount(view)).toBe(1)
  })
})
