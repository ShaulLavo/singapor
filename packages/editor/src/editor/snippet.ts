/**
 * LSP snippet syntax, parsed into text plus the stops a caret visits.
 *
 * Supports `$1`, `${1}`, `${1:default}`, `${1|a,b|}`, `$0`, variables, and `\$` escapes. Nested
 * placeholders are flattened to their default text: they are rare, and a wrong nesting is worse
 * than a shallow one.
 */

export type SnippetRange = {
  readonly start: number
  readonly end: number
}

export type SnippetStop = {
  /** Tab-stop number. `0` is the exit stop and always sorts last. */
  readonly index: number
  /** Where this stop's text sits in the expanded string; several for a repeated stop. */
  readonly ranges: readonly SnippetRange[]
}

export type ParsedSnippet = {
  /** The text to insert, with placeholders replaced by their defaults. */
  readonly text: string
  /** Stops in visit order: 1, 2, … then 0. */
  readonly stops: readonly SnippetStop[]
}

/** Variables we can answer honestly; anything else expands to empty, as the spec allows. */
export type SnippetVariables = {
  readonly selection?: string
  readonly lineIndent?: string
}

export function parseSnippet(source: string, variables: SnippetVariables = {}): ParsedSnippet {
  const parser = new SnippetParser(source, variables)
  return parser.parse()
}

/**
 * Where the caret goes when a snippet has no tab stops at all: the end of the inserted text, which
 * is what a plain completion does.
 */
export function snippetInitialSelection(parsed: ParsedSnippet, offset: number): SnippetRange {
  const first = parsed.stops[0]
  if (!first) return { end: offset + parsed.text.length, start: offset + parsed.text.length }

  const range = first.ranges[0]
  if (!range) return { end: offset + parsed.text.length, start: offset + parsed.text.length }

  return { end: offset + range.end, start: offset + range.start }
}

class SnippetParser {
  private index = 0
  private out = ''
  private readonly byStop = new Map<number, SnippetRange[]>()

  constructor(
    private readonly source: string,
    private readonly variables: SnippetVariables,
  ) {}

  parse(): ParsedSnippet {
    while (this.index < this.source.length) {
      const char = this.source[this.index]
      if (char === undefined) break

      if (char === '\\') {
        this.readEscape()
        continue
      }
      if (char === '$') {
        if (this.readTabStop()) continue
      }

      this.out += char
      this.index += 1
    }

    return { stops: this.orderedStops(), text: this.out }
  }

  /** `\$`, `\}` and `\\` are literals; a lone backslash stays a backslash. */
  private readEscape(): void {
    const next = this.source[this.index + 1]
    if (next === '$' || next === '}' || next === '\\') {
      this.out += next
      this.index += 2
      return
    }

    this.out += '\\'
    this.index += 1
  }

  /** Reads any `$…` form at the cursor. Returns false when it is a bare `$`. */
  private readTabStop(): boolean {
    const simple = /^\$(\d+)/.exec(this.source.slice(this.index))
    if (simple?.[1] !== undefined) {
      this.recordStop(Number(simple[1]), this.out.length, this.out.length)
      this.index += simple[0].length
      return true
    }

    const simpleVariable = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(this.source.slice(this.index))
    if (simpleVariable?.[1] !== undefined) {
      this.out += this.variableValue(simpleVariable[1])
      this.index += simpleVariable[0].length
      return true
    }

    if (this.source[this.index + 1] !== '{') return false

    return this.readBracedStop()
  }

  private readBracedStop(): boolean {
    const body = this.readBracedBody()
    if (body === null) return false

    const numbered = /^(\d+)(?::([\s\S]*))?$/.exec(body)
    if (numbered?.[1] !== undefined) {
      const start = this.out.length
      // A nested placeholder's default is expanded as plain text; its own stops are dropped.
      this.out += numbered[2] === undefined ? '' : parseSnippet(numbered[2], this.variables).text
      this.recordStop(Number(numbered[1]), start, this.out.length)
      return true
    }

    const choice = /^(\d+)\|([\s\S]*)\|$/.exec(body)
    if (choice?.[1] !== undefined && choice[2] !== undefined) {
      const start = this.out.length
      // The first choice is the default, matching what an editor shows before the user picks.
      this.out += choice[2].split(',')[0] ?? ''
      this.recordStop(Number(choice[1]), start, this.out.length)
      return true
    }

    const variable = /^([A-Za-z_][A-Za-z0-9_]*)(?::([\s\S]*))?$/.exec(body)
    if (variable?.[1] !== undefined) {
      const value = this.variableValue(variable[1])
      this.out += value.length > 0 ? value : (variable[2] ?? '')
      return true
    }

    return false
  }

  /** Body of a `${…}`, honouring nesting and escapes. Advances past it. Null when unterminated. */
  private readBracedBody(): string | null {
    let cursor = this.index + 2
    let depth = 1
    let body = ''

    while (cursor < this.source.length) {
      const char = this.source[cursor]
      if (char === undefined) break

      if (char === '\\') {
        body += char + (this.source[cursor + 1] ?? '')
        cursor += 2
        continue
      }
      if (char === '{') depth += 1
      if (char === '}') {
        depth -= 1
        if (depth === 0) {
          this.index = cursor + 1
          return body
        }
      }

      body += char
      cursor += 1
    }

    return null
  }

  private recordStop(index: number, start: number, end: number): void {
    const ranges = this.byStop.get(index)
    if (ranges) {
      ranges.push({ end, start })
      return
    }

    this.byStop.set(index, [{ end, start }])
  }

  /** 1, 2, 3 … then 0, because `$0` is where the caret exits. */
  private orderedStops(): readonly SnippetStop[] {
    return [...this.byStop.entries()]
      .map(([index, ranges]) => ({ index, ranges }))
      .sort((left, right) => stopOrder(left.index) - stopOrder(right.index))
  }

  private variableValue(name: string): string {
    if (name === 'TM_SELECTED_TEXT') return this.variables.selection ?? ''
    if (name === 'TM_CURRENT_LINE_INDENT') return this.variables.lineIndent ?? ''

    return ''
  }
}

function stopOrder(index: number): number {
  return index === 0 ? Number.MAX_SAFE_INTEGER : index
}
