import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createDocumentTextSnapshot,
  createPieceTableSnapshot,
  type DocumentSessionChange,
} from '../../src'

import {
  createShikiWorkerOwner,
  type ShikiResolvedRegistrations,
  type ShikiWorkerOwner,
} from '../../src/shiki'

const createChange = (text: string, edit: { from: number; to: number; text: string }) =>
  ((snapshot = createPieceTableSnapshot(text)) => ({
    kind: 'edit',
    edits: [edit],
    transaction: null,
    textSnapshot: createDocumentTextSnapshot(snapshot, text),
    snapshot,
    selections: { selections: [], normalized: true },
    timings: [],
    canUndo: false,
    canRedo: false,
    isDirty: true,
    logicalRevisionCount: 1,
    logicalRevisionScope: null,
  }))() satisfies DocumentSessionChange

describe.skipIf(typeof Worker === 'undefined')('Shiki worker highlighter', () => {
  let workerOwner: ShikiWorkerOwner

  beforeEach(() => {
    workerOwner = createShikiWorkerOwner()
  })

  afterEach(async () => {
    await workerOwner.dispose()
  })

  it('tokenizes code through the real browser Worker', async () => {
    const text = 'const value = 1;'
    const session = workerOwner.createSession({
      documentId: 'file.ts',
      languageId: 'typescript',
      lang: 'typescript',
      theme: 'github-dark',
      registrations: resolveRegistrations(),
      fullText: text,
      snapshot: createPieceTableSnapshot(text),
    })

    expect(session).not.toBeNull()

    const result = await session!.refresh(createPieceTableSnapshot(text), text)

    expect(result.tokens.length).toBeGreaterThan(0)
    expect(result.tokens.every((token) => token.start >= 0 && token.end <= text.length)).toBe(true)
    session!.dispose()
  })

  it('loads theme colors without a highlighter session', async () => {
    const theme = await workerOwner.loadTheme({
      theme: 'github-dark',
      registrations: resolveRegistrations(),
    })

    expect(theme?.backgroundColor).toBeTruthy()
    expect(theme?.foregroundColor).toBeTruthy()
  })

  it('updates tokens after an incremental edit', async () => {
    const initialText = 'const a = 1;'
    const nextText = 'const answer = 1;'
    const session = workerOwner.createSession({
      documentId: 'file.ts',
      languageId: 'typescript',
      lang: 'typescript',
      theme: 'github-dark',
      registrations: resolveRegistrations(),
      fullText: initialText,
      snapshot: createPieceTableSnapshot(initialText),
    })

    expect(session).not.toBeNull()

    await session!.refresh(createPieceTableSnapshot(initialText), initialText)
    const result = await session!.applyChange(
      createChange(nextText, { from: 6, to: 7, text: 'answer' }),
    )

    expect(result.tokens.length).toBeGreaterThan(0)
    expect(result.tokens.some((token) => token.end > initialText.length)).toBe(true)
    session!.dispose()
  })

  it('diffs from cached worker text when earlier UI edits were skipped', async () => {
    const initialText = 'const a = 1;'
    const nextText = 'const answer = 1;'
    const session = workerOwner.createSession({
      documentId: 'file.ts',
      languageId: 'typescript',
      lang: 'typescript',
      theme: 'github-dark',
      registrations: resolveRegistrations(),
      fullText: initialText,
      snapshot: createPieceTableSnapshot(initialText),
    })

    expect(session).not.toBeNull()

    await session!.refresh(createPieceTableSnapshot(initialText), initialText)
    const result = await session!.applyChange(
      createChange(nextText, { from: 11, to: 11, text: 'r' }),
    )

    expect(result.tokens.some((token) => token.start === 6 && token.end === 12)).toBe(true)
    session!.dispose()
  })

  it('disposes document tokenizer state', async () => {
    const text = 'const value = 1;'
    const session = workerOwner.createSession({
      documentId: 'file.ts',
      languageId: 'typescript',
      lang: 'typescript',
      theme: 'github-dark',
      registrations: resolveRegistrations(),
      fullText: text,
      snapshot: createPieceTableSnapshot(text),
    })

    expect(session).not.toBeNull()

    await session!.refresh(createPieceTableSnapshot(text), text)
    session!.dispose()

    const nextText = 'const nextValue = 1;'
    const nextSession = workerOwner.createSession({
      documentId: 'file.ts',
      languageId: 'typescript',
      lang: 'typescript',
      theme: 'github-dark',
      registrations: resolveRegistrations(),
      fullText: nextText,
      snapshot: createPieceTableSnapshot(nextText),
    })

    expect(nextSession).not.toBeNull()

    const next = await nextSession!.refresh(createPieceTableSnapshot(nextText), nextText)

    expect(next.tokens.length).toBeGreaterThan(0)
    nextSession!.dispose()
  })

  it('isolates equal logical documents by runtime session', async () => {
    const firstText = 'const first = 1;'
    const secondText = 'const second = 2;'
    const first = workerOwner.createSession({
      documentId: 'shared.ts',
      runtimeSessionId: 'runtime-shiki-first',
      languageId: 'typescript',
      lang: 'typescript',
      theme: 'github-dark',
      registrations: resolveRegistrations(),
      fullText: firstText,
      snapshot: createPieceTableSnapshot(firstText),
    })
    const second = workerOwner.createSession({
      documentId: 'shared.ts',
      runtimeSessionId: 'runtime-shiki-second',
      languageId: 'typescript',
      lang: 'typescript',
      theme: 'github-dark',
      registrations: resolveRegistrations(),
      fullText: secondText,
      snapshot: createPieceTableSnapshot(secondText),
    })

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()

    await Promise.all([
      first!.refresh(createPieceTableSnapshot(firstText), firstText),
      second!.refresh(createPieceTableSnapshot(secondText), secondText),
    ])
    first!.dispose()
    await workerOwner.awaitRuntimeSessionIdle('runtime-shiki-first')

    const nextText = 'const secondValue = 2;'
    const result = await second!.applyChange(
      createChange(nextText, { from: 6, to: 12, text: 'secondValue' }),
    )

    expect(result.tokens.some((token) => token.end > secondText.length)).toBe(true)
    second!.dispose()
  })
})

async function resolveRegistrations(): Promise<ShikiResolvedRegistrations> {
  const [language, theme] = await Promise.all([
    import('@shikijs/langs/typescript'),
    import('@shikijs/themes/github-dark'),
  ])
  return {
    languageRegistrations: language.default,
    themeRegistration: {
      ...theme.default,
      name: theme.default.name ?? 'github-dark',
    },
    themeRegistrations: [],
  }
}
