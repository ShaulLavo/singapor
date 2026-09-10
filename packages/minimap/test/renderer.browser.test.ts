import { describe, expect, it } from 'vitest'
import { runRasterPixelOracle } from './raster-pixel-oracle'

describe.skipIf(typeof OffscreenCanvas === 'undefined')('minimap raster reuse', () => {
  it('matches complete repaints through scrolling and invalidation', () => {
    const result = runRasterPixelOracle()
    expect(result.cases).toBe(22)
    expect(result.frames).toBe(512)
    expect(result.comparedBytes).toBeGreaterThan(0)
  })
})
