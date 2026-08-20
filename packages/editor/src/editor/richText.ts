import type { EditorTheme } from '../theme'
import type { EditorToken, EditorTokenStyle } from '../tokens'

/**
 * Past this the markup stops being worth writing: it runs several times the length of the text it
 * wraps, and the clipboard write happens synchronously inside the gesture that asked for it. The
 * plain text goes out either way, so a payload over the cap loses only its colours.
 */
const MAX_RICH_TEXT_SOURCE_LENGTH = 65536

/**
 * Characters that would let a font name end the attribute it is written into, or start something
 * else inside it. Nothing escapes the markup on its way into another application's parser, so a
 * family carrying any of these is dropped for the generic rather than repaired.
 */
const UNSAFE_FONT_FAMILY = /[:;\\/<>]/

/** Same reasoning as the font family, for a colour or decoration a theme supplied. */
const UNSAFE_STYLE_VALUE = /[:;"<>]/

const FALLBACK_FONT_FAMILY = 'monospace'
const FALLBACK_FONT_SIZE = '14px'
const FALLBACK_FONT_WEIGHT = 'normal'

/** The typography a copy carries with it, read where the document is actually being displayed. */
export type RichTextFont = {
  readonly family: string
  readonly size: string
  readonly weight: string
  readonly lineHeight: string
}

export type RichTextCopyInput = {
  readonly text: string
  /** Where `text` begins in the document, which is what the token offsets are measured against. */
  readonly startOffset: number
  readonly tokens: readonly EditorToken[]
  readonly theme: EditorTheme | null
  readonly font: RichTextFont
}

/**
 * The copied range again as styled markup, or null when it is not worth carrying.
 *
 * A document nothing has highlighted declines here rather than emitting an unstyled block: the
 * receiving application would render it exactly as it renders the plain text that travels
 * alongside, and the larger of the two payloads is the one it would prefer.
 */
export function richTextForCopy(input: RichTextCopyInput): string | null {
  const { font, startOffset, text, theme, tokens } = input
  if (text.length === 0) return null
  if (text.length > MAX_RICH_TEXT_SOURCE_LENGTH) return null

  const styled = styledTokensInRange(tokens, startOffset, startOffset + text.length)
  if (styled.length === 0) return null

  return `<div style="${rootStyle(theme, font)}">${richTextBody(text, startOffset, styled)}</div>`
}

/** Where the copy takes its typography from: whatever the element is being rendered with. */
export function readRichTextFont(element: Element): RichTextFont {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element) ?? null

  return {
    family: style?.fontFamily || FALLBACK_FONT_FAMILY,
    lineHeight: style?.lineHeight || 'normal',
    size: style?.fontSize || FALLBACK_FONT_SIZE,
    weight: style?.fontWeight || FALLBACK_FONT_WEIGHT,
  }
}

function richTextBody(text: string, startOffset: number, styled: readonly EditorToken[]): string {
  const parts: string[] = []
  let cursor = 0
  for (const token of styled) {
    // Tokens may overlap, and the one that got there first already spoke for the characters they
    // share; clamping to the cursor is what keeps a character from being emitted twice.
    const start = Math.max(token.start - startOffset, cursor)
    const end = Math.min(token.end - startOffset, text.length)
    if (end <= start) continue

    if (start > cursor) parts.push(escapeHtmlText(text.slice(cursor, start)))
    parts.push(`<span style="${inlineTokenStyle(token.style)}">`)
    parts.push(escapeHtmlText(text.slice(start, end)))
    parts.push('</span>')
    cursor = end
  }
  if (cursor < text.length) parts.push(escapeHtmlText(text.slice(cursor)))

  return parts.join('')
}

/** Tokens that overlap the range and have something to say about it, in document order. */
function styledTokensInRange(
  tokens: readonly EditorToken[],
  start: number,
  end: number,
): readonly EditorToken[] {
  const overlapping = tokens.filter(
    (token) => token.end > start && token.start < end && inlineTokenStyle(token.style).length > 0,
  )

  return overlapping.sort((a, b) => a.start - b.start || a.end - b.end)
}

function rootStyle(theme: EditorTheme | null, font: RichTextFont): string {
  const declarations = [
    styleDeclaration('color', theme?.foregroundColor),
    styleDeclaration('background-color', theme?.backgroundColor),
    `font-family: ${copyFontFamily(font.family)};`,
    styleDeclaration('font-weight', font.weight),
    styleDeclaration('font-size', font.size),
    styleDeclaration('line-height', font.lineHeight),
    // Indentation is the shape of the code, and every one of these targets collapses runs of
    // spaces unless told not to.
    'white-space: pre;',
  ]

  return declarations.join('')
}

function inlineTokenStyle(style: EditorTokenStyle): string {
  return [
    styleDeclaration('color', style.color),
    styleDeclaration('background-color', style.backgroundColor),
    styleDeclaration('font-style', style.fontStyle),
    styleDeclaration('font-weight', style.fontWeight),
    styleDeclaration('text-decoration', style.textDecoration),
  ].join('')
}

function styleDeclaration(property: string, value: string | number | undefined): string {
  if (value === undefined) return ''

  const text = typeof value === 'number' ? String(value) : value.trim()
  if (text.length === 0 || UNSAFE_STYLE_VALUE.test(text)) return ''

  return `${property}: ${text};`
}

function copyFontFamily(family: string): string {
  const declared = family.trim()
  if (declared.length === 0 || UNSAFE_FONT_FAMILY.test(declared)) return FALLBACK_FONT_FAMILY

  // A double quote would close the attribute the family is written into; the single quote a CSS
  // family list accepts just as well does not.
  const quoted = declared.replace(/"/g, "'")
  const named = /[,']/.test(quoted) ? quoted : quoteFontName(quoted)

  // Whatever this text is pasted into almost certainly does not have the font installed. Naming
  // the generic behind it is what keeps the paste monospaced there instead of reverting to prose.
  return `${named}, ${FALLBACK_FONT_FAMILY}`
}

function quoteFontName(name: string): string {
  return /[+ ]/.test(name) ? `'${name}'` : name
}

function escapeHtmlText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
