import type { EditorTokenStyle } from './tokens'

const STYLE_PROPERTIES: ReadonlyArray<{
  key: keyof EditorTokenStyle
  cssProperty: string
}> = [
  { key: 'color', cssProperty: 'color' },
  { key: 'backgroundColor', cssProperty: 'background-color' },
  { key: 'fontStyle', cssProperty: 'font-style' },
  { key: 'fontWeight', cssProperty: 'font-weight' },
  { key: 'textDecoration', cssProperty: 'text-decoration' },
]

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function serializeTokenStyle(style: EditorTokenStyle): string {
  const obj: Record<string, unknown> = {}
  for (const { key } of STYLE_PROPERTIES) obj[key] = style[key]
  return JSON.stringify(obj)
}

export function normalizeTokenStyle(style: EditorTokenStyle): EditorTokenStyle | null {
  const normalized: EditorTokenStyle = {}
  for (const { key } of STYLE_PROPERTIES) {
    if (style[key]) (normalized as Record<string, unknown>)[key] = style[key]
  }
  return Object.keys(normalized).length > 0 ? normalized : null
}

export function buildHighlightRule(name: string, style: EditorTokenStyle): string {
  const declarations: string[] = []
  for (const { key, cssProperty } of STYLE_PROPERTIES) {
    if (style[key]) declarations.push(`${cssProperty}: ${style[key]};`)
  }
  return `::highlight(${name}) { ${declarations.join(' ')} }`
}
