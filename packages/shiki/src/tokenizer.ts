import { createHighlighter } from 'shiki'
import type { GrammarState, HighlighterGeneric, ThemedToken } from 'shiki'

export interface TokenLineSnapshot {
  text: string
  tokens: readonly ThemedToken[]
}

export interface TokenPatch {
  fromLine: number
  toLine: number
  lines: readonly TokenLineSnapshot[]
}

export interface IncrementalTokenizerSnapshot {
  code: string
  lines: readonly TokenLineSnapshot[]
}

export interface CreateIncrementalTokenizerOptions {
  lang: string
  theme: string
  code?: string
  highlighter?: HighlighterGeneric<string, string>
  langs?: string[]
  themes?: string[]
}

export interface IncrementalTokenizer {
  readonly lang: string
  readonly theme: string
  applyEdit(from: number, to: number, text: string): TokenPatch
  update(code: string): TokenPatch
  reset(code?: string): TokenPatch
  getCode(): string
  getSnapshot(): IncrementalTokenizerSnapshot
  getTokens(): readonly (readonly ThemedToken[])[]
  dispose(): void
}

interface LineState {
  text: string
  tokens: readonly ThemedToken[]
  endState?: GrammarState
}

function splitLines(code: string): string[] {
  return code.split('\n').map((line) => line.endsWith('\r') ? line.slice(0, -1) : line)
}

function unique(items: readonly string[]): string[] {
  return Array.from(new Set(items))
}

function cloneSnapshot(lines: readonly LineState[]): TokenLineSnapshot[] {
  return lines.map((line) => ({
    text: line.text,
    tokens: line.tokens.slice(),
  }))
}

function grammarStatesEqual(
  left: GrammarState | undefined,
  right: GrammarState | undefined,
  theme: string,
): boolean {
  if (left === right)
    return true
  if (!left || !right)
    return false
  if (left.lang !== right.lang || left.theme !== right.theme)
    return false

  const leftStack = left.getInternalStack(theme)
  const rightStack = right.getInternalStack(theme)

  if (leftStack && rightStack)
    return leftStack.equals(rightStack)
  if (leftStack || rightStack)
    return false

  const leftScopes = left.getScopes(theme) ?? []
  const rightScopes = right.getScopes(theme) ?? []

  if (leftScopes.length !== rightScopes.length)
    return false

  return leftScopes.every((scope, index) => scope === rightScopes[index])
}

function tokenLinesEqual(
  left: readonly ThemedToken[],
  right: readonly ThemedToken[],
): boolean {
  if (left.length !== right.length)
    return false

  for (let index = 0; index < left.length; index++) {
    const leftToken = left[index]
    const rightToken = right[index]

    if (
      !leftToken
      || !rightToken
      || leftToken.content !== rightToken.content
      || leftToken.color !== rightToken.color
      || leftToken.fontStyle !== rightToken.fontStyle
    ) {
      return false
    }
  }

  return true
}

export class IncrementalShikiTokenizer implements IncrementalTokenizer {
  public readonly lang: string
  public readonly theme: string

  private code: string
  private lines: LineState[]
  private readonly highlighter: HighlighterGeneric<string, string>
  private readonly ownsHighlighter: boolean

  public constructor(
    highlighter: HighlighterGeneric<string, string>,
    options: CreateIncrementalTokenizerOptions,
    ownsHighlighter: boolean,
  ) {
    this.highlighter = highlighter
    this.ownsHighlighter = ownsHighlighter
    this.lang = options.lang
    this.theme = options.theme
    this.code = ''
    this.lines = []

    this.reset(options.code ?? '')
  }

  public applyEdit(from: number, to: number, text: string): TokenPatch {
    const newCode = this.code.slice(0, from) + text + this.code.slice(to)

    const start = this.offsetToLine(from)
    const end = this.offsetToLine(to)

    // Splice the edit into the affected line text
    const prefixText = this.lines[start.line]?.text.slice(0, start.col) ?? ''
    const suffixText = this.lines[end.line]?.text.slice(end.col) ?? ''
    const editedLines = splitLines(prefixText + text + suffixText)

    // Retokenize edited lines using the grammar state before the first affected line
    const initialState = start.line === 0 ? undefined : this.lines[start.line - 1]?.endState
    const retokenized = this.tokenizeLines(editedLines, initialState)

    // Walk forward through old suffix lines until grammar state stabilizes
    const oldSuffixStart = end.line + 1
    let stableAt = oldSuffixStart
    let state = retokenized[retokenized.length - 1]?.endState

    for (let i = oldSuffixStart; i < this.lines.length; i++) {
      const oldLine = this.lines[i]!

      if (grammarStatesEqual(state, this.lines[i - 1]?.endState, this.theme))
        break

      const retoken = this.tokenizeLine(oldLine.text, state)
      retokenized.push(retoken)
      state = retoken.endState
      stableAt = i + 1
    }

    this.code = newCode
    this.lines = [
      ...this.lines.slice(0, start.line),
      ...retokenized,
      ...this.lines.slice(stableAt),
    ]

    return {
      fromLine: start.line,
      toLine: stableAt,
      lines: cloneSnapshot(retokenized),
    }
  }

  private offsetToLine(offset: number): { line: number; col: number } {
    let remaining = offset

    for (let i = 0; i < this.lines.length; i++) {
      const len = this.lines[i]!.text.length
      if (remaining <= len)
        return { line: i, col: remaining }
      remaining -= len + 1 // +1 for the \n separator
    }

    const last = this.lines.length - 1
    return { line: last, col: this.lines[last]?.text.length ?? 0 }
  }

  private append(chunk: string): TokenPatch {
    if (chunk.length === 0)
      return { fromLine: this.lines.length, toLine: this.lines.length, lines: [] }

    const previousLength = this.lines.length
    const startLine = previousLength === 0 ? 0 : previousLength - 1
    const prefix = this.lines.slice(0, startLine)
    const previousTail = previousLength === 0 ? '' : this.lines[previousLength - 1]?.text ?? ''
    const suffixLines = splitLines(previousTail + chunk)
    const nextTail = this.tokenizeLines(suffixLines, startLine === 0 ? undefined : prefix[startLine - 1]?.endState)

    this.code += chunk
    this.lines = [...prefix, ...nextTail]

    return {
      fromLine: startLine,
      toLine: previousLength,
      lines: cloneSnapshot(nextTail),
    }
  }

  public update(code: string): TokenPatch {
    if (code === this.code)
      return { fromLine: 0, toLine: 0, lines: [] }

    if (code.startsWith(this.code))
      return this.append(code.slice(this.code.length))

    const nextLines = splitLines(code)
    const previousLines = this.lines
    const previousLength = previousLines.length
    const nextLength = nextLines.length

    let prefixLength = 0
    while (
      prefixLength < previousLength
      && prefixLength < nextLength
      && previousLines[prefixLength]?.text === nextLines[prefixLength]
    ) {
      prefixLength++
    }

    let suffixLength = 0
    while (
      suffixLength < previousLength - prefixLength
      && suffixLength < nextLength - prefixLength
      && previousLines[previousLength - 1 - suffixLength]?.text === nextLines[nextLength - 1 - suffixLength]
    ) {
      suffixLength++
    }

    const nextPrefix = previousLines.slice(0, prefixLength)
    const rebuiltMiddle: LineState[] = []
    let previousState = prefixLength === 0 ? undefined : nextPrefix[prefixLength - 1]?.endState
    const previousTailStart = previousLength - suffixLength
    const nextTailStart = nextLength - suffixLength

    for (let nextIndex = prefixLength; nextIndex < nextLength; nextIndex++) {
      const line = nextLines[nextIndex] ?? ''
      const tokenizedLine = this.tokenizeLine(line, previousState)
      previousState = tokenizedLine.endState

      const inSharedSuffix = suffixLength > 0 && nextIndex >= nextTailStart
      if (inSharedSuffix) {
        const previousIndex = previousTailStart + (nextIndex - nextTailStart)
        const previousLine = previousLines[previousIndex]
        if (
          previousLine
          && previousLine.text === line
          && tokenLinesEqual(tokenizedLine.tokens, previousLine.tokens)
          && grammarStatesEqual(tokenizedLine.endState, previousLine.endState, this.theme)
        ) {
          const nextDocument = [
            ...nextPrefix,
            ...rebuiltMiddle,
            ...previousLines.slice(previousIndex),
          ]

          this.code = code
          this.lines = nextDocument

          return {
            fromLine: prefixLength,
            toLine: previousIndex,
            lines: cloneSnapshot(rebuiltMiddle),
          }
        }
      }

      rebuiltMiddle.push(tokenizedLine)
    }

    this.code = code
    this.lines = [...nextPrefix, ...rebuiltMiddle]

    return {
      fromLine: prefixLength,
      toLine: previousLength,
      lines: cloneSnapshot(rebuiltMiddle),
    }
  }

  public reset(code = ''): TokenPatch {
    const previousLength = this.lines.length
    this.code = code
    this.lines = this.tokenizeLines(splitLines(code))

    return {
      fromLine: 0,
      toLine: previousLength,
      lines: cloneSnapshot(this.lines),
    }
  }

  public getCode(): string {
    return this.code
  }

  public getSnapshot(): IncrementalTokenizerSnapshot {
    return {
      code: this.code,
      lines: cloneSnapshot(this.lines),
    }
  }

  public getTokens(): readonly (readonly ThemedToken[])[] {
    return this.lines.map((line) => line.tokens.slice())
  }

  public dispose(): void {
    if (this.ownsHighlighter)
      this.highlighter.dispose()
  }

  private tokenizeLines(lines: readonly string[], initialState?: GrammarState): LineState[] {
    const tokenized: LineState[] = []
    let previousState = initialState

    for (const line of lines) {
      const tokenizedLine = this.tokenizeLine(line, previousState)
      tokenized.push(tokenizedLine)
      previousState = tokenizedLine.endState
    }

    return tokenized
  }

  private tokenizeLine(line: string, grammarState?: GrammarState): LineState {
    const tokenLines = this.highlighter.codeToTokensBase(line, {
      lang: this.lang,
      theme: this.theme,
      grammarState,
    })

    return {
      text: line,
      tokens: tokenLines[0] ?? [],
      endState: this.highlighter.getLastGrammarState(tokenLines),
    }
  }
}

export async function createIncrementalTokenizer(
  options: CreateIncrementalTokenizerOptions,
): Promise<IncrementalTokenizer> {
  const providedHighlighter = options.highlighter

  if (providedHighlighter)
    return new IncrementalShikiTokenizer(providedHighlighter, options, false)

  const highlighter = await createHighlighter({
    themes: unique([options.theme, ...(options.themes ?? [])]),
    langs: unique([options.lang, ...(options.langs ?? [])]),
  })

  return new IncrementalShikiTokenizer(highlighter as HighlighterGeneric<string, string>, options, true)
}
