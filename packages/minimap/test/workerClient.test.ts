import { describe, expect, it, vi } from 'vitest'
import {
  createStringTextSnapshot,
  type DocumentSessionChange,
  type TextEdit,
} from '@singapor/core/document'
import type { EditorViewSnapshot } from '@singapor/core/extensions'
import { resolveMinimapOptions } from '../src/options'
import { MinimapWorkerClient, type MinimapHost } from '../src/workerClient'
import type { MinimapWorkerRequest, MinimapWorkerResponse } from '../src/types'

describe('MinimapWorkerClient', () => {
  it('exposes worker lifecycle and waits for disposal acknowledgement before terminating', () => {
    const runtime = installMinimapRuntime()
    try {
      const host = createHost()
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions(),
        snapshot: snapshot(),
        decorations: [],
        onLayoutWidth: vi.fn(),
      })
      const worker = runtime.workers[0]!

      expect(client.inspectWorker()).toMatchObject({
        disposalAcknowledged: false,
        lifecycle: 'ready',
        lastError: null,
      })

      client.dispose()

      expect(worker.postMessage.mock.calls.at(-1)?.[0]).toEqual({ type: 'dispose' })
      expect(worker.terminate).not.toHaveBeenCalled()
      expect(client.inspectWorker()).toMatchObject({
        disposalAcknowledged: false,
        lifecycle: 'disposing',
      })

      worker.send({ type: 'disposed' })

      expect(worker.terminate).toHaveBeenCalledTimes(1)
      expect(client.inspectWorker()).toMatchObject({
        disposalAcknowledged: true,
        lifecycle: 'disposed',
      })

      host.root.remove()
      host.colorScope.remove()
    } finally {
      runtime.restore()
    }
  })

  it('records worker error responses on the owner error channel', () => {
    const runtime = installMinimapRuntime()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const host = createHost()
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions(),
        snapshot: snapshot(),
        decorations: [],
        onLayoutWidth: vi.fn(),
      })
      const worker = runtime.workers[0]!

      worker.send({ type: 'error', message: 'render failed' })

      expect(client.inspectWorker()).toMatchObject({
        lastError: 'Minimap worker request failed: render failed',
        lifecycle: 'ready',
      })
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Code: minimap.WORKER_REQUEST_FAILED'),
        expect.objectContaining({
          code: 'minimap.WORKER_REQUEST_FAILED',
          why: 'render failed',
        }),
      )

      client.dispose()
      host.root.remove()
      host.colorScope.remove()
    } finally {
      warn.mockRestore()
      runtime.restore()
    }
  })

  it('records native worker failures and terminates the owner', () => {
    const runtime = installMinimapRuntime()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const host = createHost()
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions(),
        snapshot: snapshot(),
        decorations: [],
        onLayoutWidth: vi.fn(),
      })
      const worker = runtime.workers[0]!

      worker.fail('worker crashed')

      expect(worker.terminate).toHaveBeenCalledTimes(1)
      expect(client.inspectWorker()).toMatchObject({
        lastError: 'Minimap worker crashed: worker crashed',
        lifecycle: 'crashed',
      })
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Code: minimap.WORKER_CRASHED'),
        expect.objectContaining({
          code: 'minimap.WORKER_CRASHED',
          why: 'The browser reported: worker crashed',
        }),
      )

      client.dispose()
      host.root.remove()
      host.colorScope.remove()
    } finally {
      warn.mockRestore()
      runtime.restore()
    }
  })

  it('creates actionable native worker errors when the browser omits details', () => {
    const runtime = installMinimapRuntime()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const host = createHost()
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions(),
        snapshot: snapshot(),
        decorations: [],
        onLayoutWidth: vi.fn(),
      })
      const worker = runtime.workers[0]!

      worker.fail('', { filename: 'http://localhost/minimap.worker.js', lineno: 12, colno: 8 })

      expect(worker.terminate).toHaveBeenCalledTimes(1)
      expect(client.inspectWorker()).toMatchObject({
        lastError: 'Minimap worker crashed',
        lifecycle: 'crashed',
      })
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Fix: The editor keeps running without the minimap'),
        expect.objectContaining({
          code: 'minimap.WORKER_CRASHED',
          internal: expect.objectContaining({
            filename: 'http://localhost/minimap.worker.js',
            lineNumber: 12,
            columnNumber: 8,
          }),
        }),
      )

      client.dispose()
      host.root.remove()
      host.colorScope.remove()
    } finally {
      warn.mockRestore()
      runtime.restore()
    }
  })

  it('ignores rendered responses that arrive after disposal while work is in flight', () => {
    const runtime = installMinimapRuntime()
    try {
      const host = createHost()
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions(),
        snapshot: snapshot(),
        decorations: [],
        onLayoutWidth: vi.fn(),
      })
      const worker = runtime.workers[0]!

      runtime.flushAnimationFrames()
      const sequence = lastRenderSequence(worker)

      client.dispose()
      worker.send(renderedResponse(sequence))

      expect(host.slider.style.display).toBe('')
      expect(host.slider.style.transform).toBe('')
      expect(host.slider.style.height).toBe('')
      expect(worker.terminate).not.toHaveBeenCalled()

      worker.send({ type: 'disposed' })

      expect(worker.terminate).toHaveBeenCalledTimes(1)
      expect(client.inspectWorker()).toMatchObject({
        disposalAcknowledged: true,
        lifecycle: 'disposed',
      })

      host.root.remove()
      host.colorScope.remove()
    } finally {
      runtime.restore()
    }
  })

  it('posts an initial render after the startup scheduler tick', () => {
    const runtime = installMinimapRuntime()
    try {
      const host = createHost()
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions(),
        snapshot: snapshot(),
        decorations: [],
        onLayoutWidth: vi.fn(),
      })
      const worker = runtime.workers[0]!

      expect(worker.postMessage.mock.calls.some((call) => call[0].type === 'render')).toBe(false)

      runtime.flushAnimationFrames()

      const render = worker.postMessage.mock.calls
        .map((call) => call[0] as MinimapWorkerRequest)
        .find((request): request is Extract<MinimapWorkerRequest, { type: 'render' }> => {
          return request.type === 'render'
        })

      expect(render?.sequence).toBeGreaterThan(0)
      expect(host.mainCanvas.style.height).toBe('100px')

      client.dispose()
      host.root.remove()
      host.colorScope.remove()
    } finally {
      runtime.restore()
    }
  })

  it('opens documents through the secondary projection text snapshot', () => {
    const runtime = installMinimapRuntime()
    try {
      const host = createHost()
      const initialSnapshot = snapshotWithThrowingFullText('line 1\nline 2\nline 3')
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions(),
        snapshot: initialSnapshot,
        decorations: [],
        onLayoutWidth: vi.fn(),
      })
      const worker = runtime.workers[0]!
      const openDocument = worker.postMessage.mock.calls
        .map((call) => call[0] as MinimapWorkerRequest)
        .find((request): request is Extract<MinimapWorkerRequest, { type: 'openDocument' }> => {
          return request.type === 'openDocument'
        })

      expect('text' in (openDocument?.document ?? {})).toBe(false)
      expect(openDocument?.document.textLength).toBe(20)
      expect(openDocument?.document.lineStarts).toEqual([0, 7, 14])
      expect(openDocument?.document.lines).toEqual([
        { text: 'line 1', length: 6 },
        { text: 'line 2', length: 6 },
        { text: 'line 3', length: 6 },
      ])

      client.dispose()
      host.root.remove()
      host.colorScope.remove()
    } finally {
      runtime.restore()
    }
  })

  it('clips open-document line summaries to the minimap column budget', () => {
    const runtime = installMinimapRuntime()
    try {
      const host = createHost()
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions({ maxColumn: 5 }),
        snapshot: snapshot({}, { fullText: 'abcdefghi\nshort' }),
        decorations: [],
        onLayoutWidth: vi.fn(),
      })
      const worker = runtime.workers[0]!
      const openDocument = worker.postMessage.mock.calls
        .map((call) => call[0] as MinimapWorkerRequest)
        .find((request): request is Extract<MinimapWorkerRequest, { type: 'openDocument' }> => {
          return request.type === 'openDocument'
        })

      expect('text' in (openDocument?.document ?? {})).toBe(false)
      expect(openDocument?.document.textLength).toBe(15)
      expect(openDocument?.document.lines).toEqual([
        { text: 'abcde', length: 9 },
        { text: 'short', length: 5 },
      ])

      client.dispose()
      host.root.remove()
      host.colorScope.remove()
    } finally {
      runtime.restore()
    }
  })

  it('uses mounted scroll element dimensions when initial snapshot viewport is zero-sized', () => {
    const runtime = installMinimapRuntime()
    try {
      const host = createHost()
      setElementBox(host.colorScope, { clientHeight: 320, clientWidth: 640 })
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions(),
        snapshot: snapshot({ clientHeight: 0, clientWidth: 0, scrollHeight: 0, scrollWidth: 0 }),
        decorations: [],
        onLayoutWidth: vi.fn(),
      })
      const worker = runtime.workers[0]!
      const layoutRequest = worker.postMessage.mock.calls
        .map((call) => call[0] as MinimapWorkerRequest)
        .find((request): request is Extract<MinimapWorkerRequest, { type: 'updateLayout' }> => {
          return request.type === 'updateLayout'
        })

      runtime.flushAnimationFrames()

      expect(layoutRequest?.viewport).toMatchObject({
        clientHeight: 320,
        clientWidth: 640,
        scrollHeight: 320,
        scrollWidth: 640,
      })
      expect(host.mainCanvas.style.height).toBe('320px')

      client.dispose()
      host.root.remove()
      host.colorScope.remove()
    } finally {
      runtime.restore()
    }
  })

  it('skips layout updates for scroll-only viewport changes', () => {
    const runtime = installMinimapRuntime()
    try {
      const host = createHost()
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions(),
        snapshot: snapshot({ scrollTop: 0 }),
        decorations: [],
        onLayoutWidth: vi.fn(),
      })
      const worker = runtime.workers[0]!
      worker.send(renderedResponse(1))
      worker.postMessage.mockClear()

      client.update(snapshot({ scrollTop: 120, visibleRange: { start: 6, end: 18 } }), 'viewport')
      runtime.flushAnimationFrames()

      const requests = worker.postMessage.mock.calls.map((call) => call[0] as { type: string })

      expect(requests.map((request) => request.type)).toEqual(['updateViewport', 'render'])

      client.dispose()
      host.root.remove()
      host.colorScope.remove()
    } finally {
      runtime.restore()
    }
  })

  it('keeps layout stable for same-line edits that only change content width', () => {
    const runtime = installMinimapRuntime()
    try {
      const host = createHost()
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions(),
        snapshot: snapshot(),
        decorations: [],
        onLayoutWidth: vi.fn(),
      })
      const worker = runtime.workers[0]!
      worker.send(renderedResponse(1))
      worker.postMessage.mockClear()

      const edit: TextEdit = { from: 6, to: 6, text: 'x' }
      client.update(
        snapshot({ scrollWidth: 168 }, { fullText: 'line 1x\nline 2\nline 3', contentWidth: 168 }),
        'content',
        documentEdit(edit, 'line 1x\nline 2\nline 3'),
      )
      runtime.flushAnimationFrames()

      const requests = worker.postMessage.mock.calls.map((call) => call[0] as { type: string })

      expect(requests.map((request) => request.type)).toEqual([
        'applyEdit',
        'updateViewport',
        'render',
      ])

      client.dispose()
      host.root.remove()
      host.colorScope.remove()
    } finally {
      runtime.restore()
    }
  })

  it('defers content worker updates while applying viewport feedback immediately', () => {
    const runtime = installMinimapRuntime()
    try {
      const host = createHost()
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions(),
        snapshot: snapshot({ scrollTop: 0 }),
        decorations: [],
        onLayoutWidth: vi.fn(),
      })
      const worker = runtime.workers[0]!
      worker.send(renderedResponse(1))
      worker.postMessage.mockClear()

      const edit: TextEdit = { from: 6, to: 6, text: 'x' }
      client.update(
        snapshot(
          { scrollTop: 120, visibleRange: { start: 6, end: 18 } },
          { fullText: 'line 1x\nline 2\nline 3' },
        ),
        'content',
        documentEdit(edit, 'line 1x\nline 2\nline 3'),
      )

      expect(host.slider.style.transform).toBe('translate3d(0, 32px, 0)')
      runtime.flushFrames()
      expect(worker.postMessage).not.toHaveBeenCalled()

      runtime.flushTimers()
      runtime.flushFrames()

      const requests = worker.postMessage.mock.calls.map((call) => call[0] as { type: string })
      expect(requests.map((request) => request.type)).toEqual([
        'applyEdit',
        'updateViewport',
        'render',
      ])

      client.dispose()
      host.root.remove()
      host.colorScope.remove()
    } finally {
      runtime.restore()
    }
  })

  it('keeps token payloads out of same-line edit updates', () => {
    const runtime = installMinimapRuntime()
    try {
      const host = createHost()
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions(),
        snapshot: snapshot({}, { tokens: [{ start: 0, end: 6, style: { color: '#ff0000' } }] }),
        decorations: [],
        onLayoutWidth: vi.fn(),
      })
      const worker = runtime.workers[0]!
      worker.send(renderedResponse(1))
      worker.postMessage.mockClear()

      const edit: TextEdit = { from: 6, to: 6, text: 'x' }
      client.update(
        snapshot(
          { scrollWidth: 168 },
          {
            fullText: 'line 1x\nline 2\nline 3',
            contentWidth: 168,
            tokens: [{ start: 0, end: 7, style: { color: '#ff0000' } }],
          },
        ),
        'content',
        documentEdit(edit, 'line 1x\nline 2\nline 3'),
      )
      runtime.flushAnimationFrames()

      const applyEdit = worker.postMessage.mock.calls[0]?.[0] as Extract<
        MinimapWorkerRequest,
        { type: 'applyEdit' }
      >

      expect(applyEdit.type).toBe('applyEdit')
      expect('tokens' in applyEdit.document).toBe(false)
      expect(applyEdit.document.summaryPatch.lineStarts).toBeUndefined()
      expect(applyEdit.document.summaryPatch).toMatchObject({
        startLine: 0,
        deleteCount: 1,
        lines: [{ text: 'line 1x', length: 7 }],
      })

      client.dispose()
      host.root.remove()
      host.colorScope.remove()
    } finally {
      runtime.restore()
    }
  })

  it('builds edit summary patches through the secondary projection text snapshot', () => {
    const runtime = installMinimapRuntime()
    try {
      const host = createHost()
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions(),
        snapshot: snapshotWithThrowingFullText('line 1\nline 2\nline 3'),
        decorations: [],
        onLayoutWidth: vi.fn(),
      })
      const worker = runtime.workers[0]!
      worker.send(renderedResponse(1))
      worker.postMessage.mockClear()

      const edit: TextEdit = { from: 6, to: 6, text: 'x' }
      client.update(
        snapshotWithThrowingFullText('line 1x\nline 2\nline 3'),
        'content',
        documentEdit(edit, 'line 1x\nline 2\nline 3'),
      )
      runtime.flushAnimationFrames()

      const applyEdit = worker.postMessage.mock.calls[0]?.[0] as Extract<
        MinimapWorkerRequest,
        { type: 'applyEdit' }
      >

      expect(applyEdit.type).toBe('applyEdit')
      expect('text' in applyEdit.document).toBe(false)
      expect(applyEdit.document.summaryPatch.lines).toEqual([{ text: 'line 1x', length: 7 }])

      client.dispose()
      host.root.remove()
      host.colorScope.remove()
    } finally {
      runtime.restore()
    }
  })

  it('uses incremental updates for same-line deletions', () => {
    const runtime = installMinimapRuntime()
    try {
      const host = createHost()
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions(),
        snapshot: snapshot({}, { fullText: 'abc' }),
        decorations: [],
        onLayoutWidth: vi.fn(),
      })
      const worker = runtime.workers[0]!
      worker.send(renderedResponse(1))
      worker.postMessage.mockClear()

      const edit: TextEdit = { from: 2, to: 3, text: '' }
      client.update(snapshot({}, { fullText: 'ab' }), 'content', documentEdit(edit, 'ab'))
      runtime.flushAnimationFrames()

      const requests = worker.postMessage.mock.calls.map((call) => call[0] as { type: string })

      expect(requests.map((request) => request.type)).toEqual([
        'applyEdit',
        'updateViewport',
        'render',
      ])

      client.dispose()
      host.root.remove()
      host.colorScope.remove()
    } finally {
      runtime.restore()
    }
  })

  it('uses incremental updates for multi-line deletions', () => {
    const runtime = installMinimapRuntime()
    try {
      const host = createHost()
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions(),
        snapshot: snapshot({}, { fullText: 'line 1\nline 2\nline 3' }),
        decorations: [],
        onLayoutWidth: vi.fn(),
      })
      const worker = runtime.workers[0]!
      worker.send(renderedResponse(1))
      worker.postMessage.mockClear()

      const edit: TextEdit = { from: 6, to: 7, text: '' }
      client.update(
        snapshot({}, { fullText: 'line 1line 2\nline 3' }),
        'content',
        documentEdit(edit, 'line 1line 2\nline 3'),
      )
      runtime.flushAnimationFrames()

      const requests = worker.postMessage.mock.calls.map((call) => call[0] as { type: string })

      expect(requests.map((request) => request.type)).toEqual([
        'applyEdit',
        'updateLayout',
        'render',
      ])

      client.dispose()
      host.root.remove()
      host.colorScope.remove()
    } finally {
      runtime.restore()
    }
  })

  it('includes the touched old line when building multi-line paste summary patches', () => {
    const runtime = installMinimapRuntime()
    try {
      const host = createHost()
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions(),
        snapshot: snapshot({}, { fullText: 'a\nb' }),
        decorations: [],
        onLayoutWidth: vi.fn(),
      })
      const worker = runtime.workers[0]!
      worker.send(renderedResponse(1))
      worker.postMessage.mockClear()

      const edit: TextEdit = { from: 2, to: 2, text: 'x\ny\n' }
      client.update(
        snapshot({}, { fullText: 'a\nx\ny\nb' }),
        'content',
        documentEdit(edit, 'a\nx\ny\nb'),
      )
      runtime.flushAnimationFrames()

      const applyEdit = worker.postMessage.mock.calls[0]?.[0] as Extract<
        MinimapWorkerRequest,
        { type: 'applyEdit' }
      >

      expect(applyEdit.type).toBe('applyEdit')
      expect(applyEdit.document.summaryPatch).toMatchObject({
        startLine: 1,
        deleteCount: 1,
        lines: [
          { text: 'x', length: 1 },
          { text: 'y', length: 1 },
          { text: 'b', length: 1 },
        ],
      })

      client.dispose()
      host.root.remove()
      host.colorScope.remove()
    } finally {
      runtime.restore()
    }
  })

  it('queues incremental edits while a render is in flight', () => {
    const runtime = installMinimapRuntime()
    try {
      const host = createHost()
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions(),
        snapshot: snapshot(),
        decorations: [],
        onLayoutWidth: vi.fn(),
      })
      const worker = runtime.workers[0]!
      worker.send(renderedResponse(1))
      worker.postMessage.mockClear()

      const firstEdit: TextEdit = { from: 6, to: 6, text: 'x' }
      client.update(
        snapshot({}, { fullText: 'line 1x\nline 2\nline 3' }),
        'content',
        documentEdit(firstEdit, 'line 1x\nline 2\nline 3'),
      )
      runtime.flushAnimationFrames()
      const inFlightSequence = lastRenderSequence(worker)
      worker.postMessage.mockClear()

      const secondEdit: TextEdit = { from: 7, to: 7, text: 'y' }
      const thirdEdit: TextEdit = { from: 8, to: 8, text: 'z' }
      client.update(
        snapshot({}, { fullText: 'line 1xy\nline 2\nline 3' }),
        'content',
        documentEdit(secondEdit, 'line 1xy\nline 2\nline 3'),
      )
      client.update(
        snapshot({}, { fullText: 'line 1xyz\nline 2\nline 3' }),
        'content',
        documentEdit(thirdEdit, 'line 1xyz\nline 2\nline 3'),
      )
      runtime.flushAnimationFrames()

      expect(worker.postMessage).not.toHaveBeenCalled()

      worker.send(renderedResponse(inFlightSequence))
      runtime.flushAnimationFrames()

      const requests = worker.postMessage.mock.calls.map((call) => call[0] as MinimapWorkerRequest)
      const applyEdits = requests[0] as Extract<MinimapWorkerRequest, { type: 'applyEdits' }>

      expect(requests.map((request) => request.type)).toEqual([
        'applyEdits',
        'updateViewport',
        'render',
      ])
      expect(applyEdits.edits).toEqual([secondEdit, thirdEdit])
      expect(applyEdits.document.summaryPatch).toMatchObject({
        startLine: 0,
        deleteCount: 1,
        lines: [{ text: 'line 1xyz', length: 9 }],
      })

      client.dispose()
      host.root.remove()
      host.colorScope.remove()
    } finally {
      runtime.restore()
    }
  })

  it('coalesces rapid same-line edits into one summary patch before flushing', () => {
    const runtime = installMinimapRuntime()
    try {
      const host = createHost()
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions(),
        snapshot: snapshotWithThrowingFullText('line 1\nline 2\nline 3'),
        decorations: [],
        onLayoutWidth: vi.fn(),
      })
      const worker = runtime.workers[0]!
      worker.send(renderedResponse(1))
      worker.postMessage.mockClear()

      client.update(
        snapshotWithThrowingFullText('line 1x\nline 2\nline 3'),
        'content',
        documentEdit({ from: 6, to: 6, text: 'x' }, 'line 1x\nline 2\nline 3'),
      )
      client.update(
        snapshotWithThrowingFullText('line 1xy\nline 2\nline 3'),
        'content',
        documentEdit({ from: 7, to: 7, text: 'y' }, 'line 1xy\nline 2\nline 3'),
      )
      runtime.flushFrames()

      expect(worker.postMessage).not.toHaveBeenCalled()

      runtime.flushTimers()
      runtime.flushFrames()

      const requests = worker.postMessage.mock.calls.map((call) => call[0] as MinimapWorkerRequest)
      const applyEdits = requests[0] as Extract<MinimapWorkerRequest, { type: 'applyEdits' }>

      expect(requests.map((request) => request.type)).toEqual([
        'applyEdits',
        'updateViewport',
        'render',
      ])
      expect(applyEdits.edits).toEqual([
        { from: 6, to: 6, text: 'x' },
        { from: 7, to: 7, text: 'y' },
      ])
      expect('text' in applyEdits.document).toBe(false)
      expect(applyEdits.document.summaryPatch).toMatchObject({
        startLine: 0,
        deleteCount: 1,
        lines: [{ text: 'line 1xy', length: 8 }],
      })

      client.dispose()
      host.root.remove()
      host.colorScope.remove()
    } finally {
      runtime.restore()
    }
  })

  it('uses incremental updates for batched same-line edits', () => {
    const runtime = installMinimapRuntime()
    try {
      const host = createHost()
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions(),
        snapshot: snapshot({}, { fullText: 'abc def ghi' }),
        decorations: [],
        onLayoutWidth: vi.fn(),
      })
      const worker = runtime.workers[0]!
      worker.send(renderedResponse(1))
      worker.postMessage.mockClear()

      const edits: readonly TextEdit[] = [
        { from: 0, to: 0, text: 'x' },
        { from: 4, to: 4, text: 'y' },
      ]
      client.update(
        snapshot({}, { fullText: 'xabc ydef ghi' }),
        'content',
        documentEdits(edits, 'xabc ydef ghi'),
      )
      runtime.flushAnimationFrames()

      const requests = worker.postMessage.mock.calls.map((call) => call[0] as MinimapWorkerRequest)
      const applyEdits = requests[0] as Extract<MinimapWorkerRequest, { type: 'applyEdits' }>

      expect(requests.map((request) => request.type)).toEqual([
        'applyEdits',
        'updateViewport',
        'render',
      ])
      expect(applyEdits.edits).toEqual([
        { from: 0, to: 0, text: 'x' },
        { from: 5, to: 5, text: 'y' },
      ])
      expect(applyEdits.document.summaryPatch).toMatchObject({
        startLine: 0,
        deleteCount: 1,
        lines: [{ text: 'xabc ydef ghi', length: 13 }],
      })

      client.dispose()
      host.root.remove()
      host.colorScope.remove()
    } finally {
      runtime.restore()
    }
  })

  it('coalesces pending content edits with token range patches', () => {
    const runtime = installMinimapRuntime()
    try {
      const host = createHost()
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions(),
        snapshot: snapshot(
          {},
          {
            tokens: [
              { start: 0, end: 6, style: { color: '#ff0000' } },
              { start: 7, end: 13, style: { color: '#00ff00' } },
            ],
          },
        ),
        decorations: [],
        onLayoutWidth: vi.fn(),
      })
      const worker = runtime.workers[0]!
      worker.send(renderedResponse(1))
      worker.postMessage.mockClear()

      const projectedTokens = [
        { start: 0, end: 7, style: { color: '#ff0000' } },
        { start: 8, end: 14, style: { color: '#00ff00' } },
      ]
      const refreshedTokens = [
        projectedTokens[0]!,
        { start: 8, end: 14, style: { color: '#0000ff' } },
      ]
      const edit: TextEdit = { from: 6, to: 6, text: 'x' }
      client.update(
        snapshot({}, { fullText: 'line 1x\nline 2\nline 3', tokens: projectedTokens }),
        'content',
        documentEdit(edit, 'line 1x\nline 2\nline 3'),
      )
      client.update(
        snapshot({}, { fullText: 'line 1x\nline 2\nline 3', tokens: refreshedTokens }),
        'tokens',
      )
      runtime.flushAnimationFrames()

      const requests = worker.postMessage.mock.calls.map((call) => call[0] as MinimapWorkerRequest)
      const applyEdit = requests[0] as Extract<MinimapWorkerRequest, { type: 'applyEdit' }>
      const tokenPatch = requests[1] as Extract<MinimapWorkerRequest, { type: 'updateTokenRange' }>

      expect(requests.map((request) => request.type)).toEqual([
        'applyEdit',
        'updateTokenRange',
        'updateViewport',
        'render',
      ])
      expect('tokens' in applyEdit.document).toBe(false)
      expect(applyEdit.document.summaryPatch.lines).toEqual([{ text: 'line 1x', length: 7 }])
      expect(tokenPatch.patch).toMatchObject({
        start: 1,
        deleteCount: 1,
        tokens: [{ start: 8, end: 14 }],
      })

      client.dispose()
      host.root.remove()
      host.colorScope.remove()
    } finally {
      runtime.restore()
    }
  })

  it('sends external decoration updates without a full decoration payload', () => {
    const runtime = installMinimapRuntime()
    try {
      const host = createHost()
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions(),
        snapshot: snapshot(),
        decorations: [],
        onLayoutWidth: vi.fn(),
      })
      const worker = runtime.workers[0]!
      worker.send(renderedResponse(1))
      worker.postMessage.mockClear()

      const decoration = {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 2,
        color: '#ff0000',
        position: 'inline' as const,
      }
      client.setExternalDecorations(snapshot(), [decoration])
      runtime.flushAnimationFrames()

      const requests = worker.postMessage.mock.calls.map((call) => call[0] as MinimapWorkerRequest)

      expect(requests.map((request) => request.type)).toEqual([
        'updateExternalDecorations',
        'render',
      ])
      expect(requests[0]).toMatchObject({
        type: 'updateExternalDecorations',
        decorations: [decoration],
      })

      client.dispose()
      host.root.remove()
      host.colorScope.remove()
    } finally {
      runtime.restore()
    }
  })

  it('sends token range patches after incremental edit token refreshes', () => {
    const runtime = installMinimapRuntime()
    try {
      const host = createHost()
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions(),
        snapshot: snapshot(
          {},
          {
            tokens: [
              { start: 0, end: 6, style: { color: '#ff0000' } },
              { start: 7, end: 11, style: { color: '#00ff00' } },
              { start: 12, end: 18, style: { color: '#0000ff' } },
            ],
          },
        ),
        decorations: [],
        onLayoutWidth: vi.fn(),
      })
      const worker = runtime.workers[0]!
      worker.send(renderedResponse(1))
      worker.postMessage.mockClear()

      const edit: TextEdit = { from: 6, to: 6, text: 'x' }
      const projectedTokens = [
        { start: 0, end: 7, style: { color: '#ff0000' } },
        { start: 8, end: 12, style: { color: '#00ff00' } },
        { start: 13, end: 19, style: { color: '#0000ff' } },
      ]
      client.update(
        snapshot({}, { fullText: 'line 1x\nline 2\nline 3', tokens: projectedTokens }),
        'content',
        documentEdit(edit, 'line 1x\nline 2\nline 3'),
      )
      runtime.flushAnimationFrames()
      worker.send(renderedResponse(lastRenderSequence(worker)))
      worker.postMessage.mockClear()

      client.update(
        snapshot(
          {},
          {
            fullText: 'line 1x\nline 2\nline 3',
            tokens: [
              projectedTokens[0]!,
              { start: 8, end: 12, style: { color: '#ffffff' } },
              projectedTokens[2]!,
            ],
          },
        ),
        'tokens',
      )
      runtime.flushAnimationFrames()

      const requests = worker.postMessage.mock.calls.map((call) => call[0] as MinimapWorkerRequest)
      const tokenPatch = requests[0] as Extract<MinimapWorkerRequest, { type: 'updateTokenRange' }>

      expect(requests.map((request) => request.type)).toEqual(['updateTokenRange', 'render'])
      expect(tokenPatch.patch).toMatchObject({
        start: 1,
        deleteCount: 1,
        tokens: [{ start: 8, end: 12 }],
      })

      client.dispose()
      host.root.remove()
      host.colorScope.remove()
    } finally {
      runtime.restore()
    }
  })
})

function createHost(): MinimapHost {
  const root = document.createElement('div')
  const colorScope = document.createElement('div')
  const shadow = document.createElement('div')
  const mainCanvas = document.createElement('canvas')
  const decorationsCanvas = document.createElement('canvas')
  const slider = document.createElement('div')
  const sliderHorizontal = document.createElement('div')
  colorScope.style.color = 'rgb(212, 212, 212)'
  colorScope.style.backgroundColor = 'rgb(30, 30, 30)'
  slider.appendChild(sliderHorizontal)
  root.append(shadow, mainCanvas, decorationsCanvas, slider)
  document.body.append(colorScope, root)
  return { root, colorScope, shadow, mainCanvas, decorationsCanvas, slider, sliderHorizontal }
}

function setElementBox(
  element: HTMLElement,
  box: { readonly clientHeight: number; readonly clientWidth: number },
): void {
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: box.clientHeight })
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: box.clientWidth })
}

function snapshot(
  viewport: Partial<EditorViewSnapshot['viewport']> = {},
  overrides: Partial<Pick<EditorViewSnapshot, 'contentWidth' | 'fullText' | 'tokens'>> = {},
): EditorViewSnapshot {
  const text = overrides.fullText ?? 'line 1\nline 2\nline 3'
  const starts = lineStarts(text)
  const contentWidth = overrides.contentWidth ?? 160
  return {
    documentId: 'minimap-test',
    languageId: 'typescript',
    textSnapshot: createStringTextSnapshot(text),
    fullText: text,
    textVersion: 1,
    lineStarts: starts,
    tokens: overrides.tokens ?? [],
    brackets: [],
    selections: [],
    metrics: { rowHeight: 20, characterWidth: 8 },
    lineCount: starts.length,
    contentWidth,
    totalHeight: 60,
    tabSize: 4,
    foldMarkers: [],
    visibleRows: [],
    viewport: {
      scrollTop: 0,
      scrollLeft: 0,
      scrollHeight: 400,
      scrollWidth: contentWidth,
      clientHeight: 100,
      clientWidth: 240,
      borderBoxHeight: 100,
      borderBoxWidth: 240,
      visibleRange: { start: 0, end: 3 },
      ...viewport,
    },
  }
}

function snapshotWithThrowingFullText(text: string): EditorViewSnapshot {
  const initialSnapshot = snapshot({}, { fullText: text })
  Object.defineProperty(initialSnapshot, 'textSnapshot', {
    configurable: true,
    enumerable: true,
    value: createStringTextSnapshot(text),
  })
  Object.defineProperty(initialSnapshot, 'fullText', {
    configurable: true,
    enumerable: true,
    get: () => {
      throw new Error('fullText should not be read')
    },
  })
  return initialSnapshot
}

function documentEdit(edit: TextEdit, _fullText: string): DocumentSessionChange {
  return documentEdits([edit])
}

function documentEdits(edits: readonly TextEdit[], _fullText?: string): DocumentSessionChange {
  return { kind: 'edit', edits } as unknown as DocumentSessionChange
}

function lineStarts(text: string): readonly number[] {
  const starts = [0]
  let index = text.indexOf('\n')
  while (index !== -1) {
    starts.push(index + 1)
    index = text.indexOf('\n', index + 1)
  }
  return starts
}

function renderedResponse(sequence: number): MinimapWorkerResponse {
  return {
    type: 'rendered',
    sequence,
    sliderNeeded: true,
    sliderTop: 0,
    sliderHeight: 20,
    shadowVisible: false,
  }
}

function lastRenderSequence(worker: MockWorker): number {
  const request = worker.postMessage.mock.calls
    .map((call) => call[0] as MinimapWorkerRequest)
    .findLast((item): item is Extract<MinimapWorkerRequest, { type: 'render' }> => {
      return item.type === 'render'
    })
  if (!request) throw new Error('Expected a render request')
  return request.sequence
}

function installMinimapRuntime(): {
  readonly workers: MockWorker[]
  readonly flushFrames: () => void
  readonly flushTimers: () => void
  readonly flushAnimationFrames: () => void
  readonly restore: () => void
} {
  const workers: MockWorker[] = []
  const frames: (() => void)[] = []
  const worker = Object.getOwnPropertyDescriptor(globalThis, 'Worker')
  const offscreenCanvas = Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas')
  const requestAnimationFrame = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame')
  const cancelAnimationFrame = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame')
  const setTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout')
  const clearTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'clearTimeout')
  const requestIdleCallback = Object.getOwnPropertyDescriptor(globalThis, 'requestIdleCallback')
  const cancelIdleCallback = Object.getOwnPropertyDescriptor(globalThis, 'cancelIdleCallback')
  const transferControlToOffscreen = Object.getOwnPropertyDescriptor(
    HTMLCanvasElement.prototype,
    'transferControlToOffscreen',
  )
  const timers = new Map<number, () => void>()
  let nextTimer = 1

  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    value: class extends MockWorker {
      public constructor(url: URL, options?: WorkerOptions) {
        super(url, options)
        workers.push(this)
      }
    },
  })
  Object.defineProperty(globalThis, 'OffscreenCanvas', {
    configurable: true,
    value: class MockOffscreenCanvas {},
  })
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: () => void) => {
      frames.push(callback)
      return frames.length
    },
  })
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    value: vi.fn(),
  })
  Object.defineProperty(globalThis, 'setTimeout', {
    configurable: true,
    value: (callback: () => void) => {
      const timer = nextTimer
      nextTimer += 1
      timers.set(timer, callback)
      return timer
    },
  })
  Object.defineProperty(globalThis, 'clearTimeout', {
    configurable: true,
    value: (timer: number) => {
      timers.delete(timer)
    },
  })
  Object.defineProperty(globalThis, 'requestIdleCallback', {
    configurable: true,
    value: undefined,
  })
  Object.defineProperty(globalThis, 'cancelIdleCallback', {
    configurable: true,
    value: vi.fn(),
  })
  Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
    configurable: true,
    value: () => ({}),
  })

  const flushTimerQueue = () => {
    while (timers.size > 0) {
      for (const [timer, callback] of Array.from(timers)) {
        timers.delete(timer)
        callback()
      }
    }
  }

  return {
    workers,
    flushFrames: () => {
      for (const frame of frames.splice(0)) frame()
    },
    flushTimers: flushTimerQueue,
    flushAnimationFrames: () => {
      flushTimerQueue()
      for (const frame of frames.splice(0)) frame()
    },
    restore: () => {
      restoreDescriptor(globalThis, 'Worker', worker)
      restoreDescriptor(globalThis, 'OffscreenCanvas', offscreenCanvas)
      restoreDescriptor(globalThis, 'requestAnimationFrame', requestAnimationFrame)
      restoreDescriptor(globalThis, 'cancelAnimationFrame', cancelAnimationFrame)
      restoreDescriptor(globalThis, 'setTimeout', setTimeoutDescriptor)
      restoreDescriptor(globalThis, 'clearTimeout', clearTimeoutDescriptor)
      restoreDescriptor(globalThis, 'requestIdleCallback', requestIdleCallback)
      restoreDescriptor(globalThis, 'cancelIdleCallback', cancelIdleCallback)
      restoreDescriptor(
        HTMLCanvasElement.prototype,
        'transferControlToOffscreen',
        transferControlToOffscreen,
      )
    },
  }
}

class MockWorker {
  public onmessage: ((event: MessageEvent<MinimapWorkerResponse>) => void) | null = null
  public onerror: ((event: ErrorEvent) => void) | null = null
  public postMessage = vi.fn()
  public terminate = vi.fn()

  public constructor(_url: URL, _options?: WorkerOptions) {}

  public send(response: MinimapWorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<MinimapWorkerResponse>)
  }

  public fail(message: string, init: Partial<ErrorEvent> = {}): void {
    this.onerror?.({
      colno: init.colno ?? 0,
      error: init.error,
      filename: init.filename ?? '',
      lineno: init.lineno ?? 0,
      message,
    } as ErrorEvent)
  }
}

function restoreDescriptor(
  target: object,
  property: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(target, property, descriptor)
    return
  }

  Reflect.deleteProperty(target, property)
}
