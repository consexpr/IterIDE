import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const f = vi.hoisted(() => {
    let state: any, model: any, editor: any
    const callbacks = new Map<number, FrameRequestCallback>()
    let nextFrame = 0
    const ref: any = { editor: null, lang: { format: vi.fn(async () => []), setHoverEnabled: vi.fn() } }
    const emptyDebug = () => ({
        state: { status: 'idle' },
        path: '/a.cpp',
        testId: '1',
        stdout: '',
        stderr: '',
        locals: [],
        stack: [],
        frame: 0,
        tab: 'variables',
        bpInfo: []
    })
    const api: any = {
        app: { platform: 'linux' },
        fs: { writeText: vi.fn(async () => {}) },
        problem: { saved: vi.fn(async () => {}) },
        debug: {
            onEvent: vi.fn(),
            start: vi.fn(async () => {}),
            command: vi.fn(async () => {}),
            seek: vi.fn(async () => {}),
            locals: vi.fn(async () => []),
            stack: vi.fn(async () => []),
            setBreakpoints: vi.fn(async () => {})
        },
        judge: { stop: vi.fn(async () => {}) }
    }
    const reset = () => {
        let text = 'int T;\nint main(){\ncin>>T;while(T--) solve();\n}\n',
            version = 1,
            disposed = false,
            nextId = 0,
            readOnly = false
        const decorations = new Map<string, any>(),
            changes = new Set<() => void>(),
            disposals = new Set<() => void>()
        const emit = () => {
            for (const cb of changes) cb()
        }
        model = {
            getValue: () => text,
            getVersionId: () => version,
            getAlternativeVersionId: () => version,
            isDisposed: () => disposed,
            getLineContent: (line: number) => text.split('\n')[line - 1] ?? '',
            getLineCount: () => text.split('\n').length,
            getLineFirstNonWhitespaceColumn: (line: number) => {
                const n = /\S/.exec(text.split('\n')[line - 1] ?? '')
                return n ? n.index + 1 : 0
            },
            deltaDecorations: (old: string[], values: any[]) => {
                old.forEach((id) => decorations.delete(id))
                const ids = values.map((value) => {
                    const id = String(++nextId)
                    decorations.set(id, { ...value.range })
                    return id
                })
                emit()
                return ids
            },
            getDecorationRange: (id: string) => decorations.get(id) ?? null,
            onDidChangeDecorations: (cb: () => void) => {
                changes.add(cb)
                return { dispose: () => changes.delete(cb) }
            },
            onWillDispose: (cb: () => void) => {
                disposals.add(cb)
                return { dispose: () => disposals.delete(cb) }
            },
            pushStackElement: vi.fn(),
            pushEditOperations: (_a: any, edits: any[]) => model.replace(edits[0].text),
            replace: (next: string) => {
                text = next
                version++
                // A broad replacement can collapse markers; the application must preserve statement identity.
                for (const range of decorations.values())
                    range.startLineNumber = range.endLineNumber = model.getLineCount()
                emit()
            },
            insertLines: (count: number) => {
                text = '\n'.repeat(count) + text
                version++
                for (const range of decorations.values()) {
                    range.startLineNumber += count
                    range.endLineNumber += count
                }
                emit()
            },
            dispose: () => {
                for (const cb of disposals) cb()
                disposed = true
            },
            decorationListeners: changes
        }
        const collection = () => {
            let ids: string[] = []
            return {
                set: (values: any[]) => {
                    ids = model.deltaDecorations(ids, values)
                },
                clear: () => {
                    ids = model.deltaDecorations(ids, [])
                }
            }
        }
        editor = {
            getModel: () => model,
            getSelections: () => [],
            saveViewState: () => null,
            setModel: vi.fn(),
            focus: vi.fn(),
            getAction: vi.fn((id: string) =>
                id === 'editor.action.hideHover' ? { run: vi.fn(async () => {}) } : null
            ),
            updateOptions: vi.fn((options: any) => {
                if ('readOnly' in options) readOnly = options.readOnly
            }),
            revealLineInCenterIfOutsideViewport: vi.fn(),
            createDecorationsCollection: collection,
            executeEdits: (_source: string, edits: any[]) => {
                if (readOnly) return false
                model.replace(edits[0].text)
                return true
            }
        }
        ref.editor = editor
        state = {
            activePath: '/a.cpp',
            closing: false,
            settings: { autoSave: true, editor: { formatOnSave: false } },
            breakpoints: {},
            files: [
                {
                    path: '/a.cpp',
                    name: 'a.cpp',
                    model,
                    dirty: false,
                    savedVersion: 1,
                    runId: null,
                    tests: [],
                    problem: {
                        fileIO: { enabled: false, input: 'a.in', output: 'a.out' },
                        tests: [{ id: '1', enabled: true }]
                    }
                }
            ],
            debug: emptyDebug()
        }
        callbacks.clear()
        nextFrame = 0
    }
    reset()
    return {
        get state() {
            return state
        },
        set state(v) {
            state = v
        },
        get model() {
            return model
        },
        get editor() {
            return editor
        },
        ref,
        api,
        reset,
        emptyDebug,
        toast: vi.fn(),
        raf: (cb: FrameRequestCallback) => {
            callbacks.set(++nextFrame, cb)
            return nextFrame
        },
        cancelRaf: (id: number) => callbacks.delete(id),
        runFrames: () => {
            const pending = [...callbacks.values()]
            callbacks.clear()
            pending.forEach((cb) => cb(0))
        }
    }
})

vi.mock('../state/app', () => ({
    store: {
        get: () => f.state,
        set: (patch: any) => {
            f.state = { ...f.state, ...(typeof patch === 'function' ? patch(f.state) : patch) }
        }
    },
    activeFile: (state = f.state) => state.files.find((file: any) => file.path === state.activePath) ?? null,
    updateFile: (path: string, patch: any) => {
        f.state = {
            ...f.state,
            files: f.state.files.map((file: any) =>
                file.path === path ? { ...file, ...(typeof patch === 'function' ? patch(file) : patch) } : file
            )
        }
    },
    isDebugging: () => !['idle', 'error'].includes(f.state.debug.state.status),
    emptyDebug: f.emptyDebug,
    toast: f.toast
}))
vi.mock('../editor/instance', () => ({ editorRef: f.ref }))
vi.mock('../editor/monaco', () => ({
    monaco: {
        Range: class {
            constructor(
                public startLineNumber: number,
                public startColumn: number,
                public endLineNumber: number,
                public endColumn: number
            ) {}
        }
    }
}))

const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
}
const paused = (patch: any = {}) => ({
    status: 'paused',
    reason: 'breakpoint',
    file: '/a.cpp',
    line: 3,
    frame: 0,
    stepIndex: 1,
    mode: 'replay',
    totalSteps: 10,
    recordingComplete: false,
    recordingEnded: false,
    recordingMs: 200,
    canStepBack: true,
    ...patch
})
beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    f.reset()
    vi.stubGlobal('window', { iter: f.api })
    vi.stubGlobal('requestAnimationFrame', f.raf)
    vi.stubGlobal('cancelAnimationFrame', f.cancelRaf)
})
afterEach(() => vi.unstubAllGlobals())

describe('debug navigation ownership and breakpoint identity', () => {
    it('updates recording metadata without scrolling or querying paused variables again', async () => {
        const debug = await import('./debug')
        debug.listenDebug()
        const event = f.api.debug.onEvent.mock.calls[0][0]
        event({ type: 'state', state: paused() })
        await flush()
        for (const totalSteps of [20, 40, 80])
            event({ type: 'state', state: paused({ totalSteps, recordingMs: totalSteps * 100 }) })
        await flush()
        expect(f.state.debug.state.totalSteps).toBe(80)
        expect(f.editor.revealLineInCenterIfOutsideViewport).toHaveBeenCalledTimes(1)
        expect(f.api.debug.locals).toHaveBeenCalledTimes(1)
        expect(f.api.debug.stack).toHaveBeenCalledTimes(1)
    })

    it('accepts an in-flight locals response across metadata but rejects it across a real step', async () => {
        const debug = await import('./debug')
        debug.listenDebug()
        const event = f.api.debug.onEvent.mock.calls[0][0]
        let resolve!: (value: any[]) => void
        f.api.debug.locals.mockImplementationOnce(
            () =>
                new Promise((r) => {
                    resolve = r
                })
        )
        event({ type: 'state', state: paused() })
        event({ type: 'state', state: paused({ totalSteps: 25 }) })
        resolve([{ name: 'T', value: '3' }])
        await flush()
        expect(f.state.debug.locals).toEqual([{ name: 'T', value: '3' }])
        let stale!: (value: any[]) => void
        f.api.debug.locals
            .mockImplementationOnce(
                () =>
                    new Promise((r) => {
                        stale = r
                    })
            )
            .mockResolvedValueOnce([{ name: 'T', value: '1' }])
        event({ type: 'state', state: paused({ stepIndex: 2, line: 4 }) })
        event({ type: 'state', state: paused({ stepIndex: 3, line: 3 }) })
        await flush()
        stale([{ name: 'T', value: '2' }])
        await flush()
        expect(f.state.debug.locals).toEqual([{ name: 'T', value: '1' }])
    })

    it('refreshes a new navigation to the same stop while rejecting its previous pending variables', async () => {
        const debug = await import('./debug')
        debug.listenDebug()
        const event = f.api.debug.onEvent.mock.calls[0][0]
        let stale!: (value: any[]) => void
        f.api.debug.locals
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        stale = resolve
                    })
            )
            .mockResolvedValueOnce([{ name: 'T', value: '3' }])
        event({ type: 'state', state: paused({ reason: 'seek' }) })
        debug.seekDebug(1)
        event({ type: 'state', state: paused({ reason: 'seek', totalSteps: 20 }) })
        await flush()
        expect(f.api.debug.locals).toHaveBeenCalledTimes(2)
        expect(f.api.debug.stack).toHaveBeenCalledTimes(2)
        expect(f.state.debug.locals).toEqual([{ name: 'T', value: '3' }])
        stale([{ name: 'T', value: 'stale' }])
        await flush()
        expect(f.state.debug.locals).toEqual([{ name: 'T', value: '3' }])
        expect(f.editor.revealLineInCenterIfOutsideViewport).toHaveBeenCalledTimes(1)
    })

    it('rejects a timeline frame queued before a newer navigation', async () => {
        const debug = await import('./debug')
        f.state.debug.state = paused()
        ;(debug as any).scheduleDebugSeek(8)
        debug.debugCommand('restart')
        f.runFrames()
        expect(f.api.debug.seek).not.toHaveBeenCalled()
        ;(debug as any).scheduleDebugSeek(4)
        f.runFrames()
        expect(f.api.debug.seek).toHaveBeenCalledExactlyOnceWith(4)
    })

    it('does not send an old timeline seek into a starting session', async () => {
        const debug = await import('./debug')
        f.state.debug.state = paused()
        ;(debug as any).scheduleDebugSeek(8)
        const starting = debug.startDebug()
        f.runFrames()
        await starting
        expect(f.api.debug.seek).not.toHaveBeenCalled()
    })

    it('updates stored breakpoint lines when model decorations move', async () => {
        const debug = await import('./debug')
        f.state.breakpoints['/a.cpp'] = [{ line: 3, enabled: true, condition: 'T > 0', hitCondition: 2 }]
        debug.renderBreakpoints()
        f.model.insertLines(2)
        expect(f.state.breakpoints['/a.cpp']).toEqual([{ line: 5, enabled: true, condition: 'T > 0', hitCondition: 2 }])
    })

    it('tracks broad native whitespace formatting on a background model and releases its listener on close', async () => {
        const debug = await import('./debug')
        f.state.breakpoints['/a.cpp'] = [{ line: 3, enabled: true, condition: 'T > 0' }]
        f.ref.editor = null
        debug.renderBreakpoints()
        f.model.replace('int T;\n\nint main() {\n  cin >> T;\n  while (T--)\n    solve();\n}\n')
        expect(f.state.breakpoints['/a.cpp']).toEqual([{ line: 4, enabled: true, condition: 'T > 0' }])
        expect(f.model.decorationListeners.size).toBe(1)
        f.model.dispose()
        expect(f.model.decorationListeners.size).toBe(0)
    })

    it('passes the same cin statement after save formatting, even when the formatter replaces a broad range', async () => {
        const debug = await import('./debug')
        f.state.breakpoints['/a.cpp'] = [{ line: 3, enabled: true }]
        debug.renderBreakpoints()
        const formatted = 'int T;\n\nint main() {\n  cin >> T;\n  while (T--)\n    solve();\n}\n'
        f.ref.lang.format.mockResolvedValueOnce([{ range: {}, text: formatted }] as any)
        f.state.settings.editor.formatOnSave = true
        f.state.files[0].dirty = true
        await debug.startDebug()
        expect(f.api.fs.writeText).toHaveBeenCalledWith(
            '/a.cpp',
            formatted,
            expect.objectContaining({ confirmOverwrite: false })
        )
        expect(f.api.debug.start).toHaveBeenCalledWith(
            expect.objectContaining({ breakpoints: [{ line: 4, enabled: true }] })
        )
        expect(f.model.getLineContent(f.state.breakpoints['/a.cpp'][0].line)).toContain('cin >> T')
    })

    it('applies save formatting through the model while startup keeps the active editor read-only', async () => {
        const debug = await import('./debug')
        const formatted = 'int T;\nint main() {\n  cin >> T;\n  while (T--)\n    solve();\n}\n'
        f.ref.lang.format.mockResolvedValueOnce([{ range: {}, text: formatted }] as any)
        f.state.settings.editor.formatOnSave = true
        f.state.files[0].dirty = true
        await debug.startDebug()
        expect(f.api.fs.writeText).toHaveBeenCalledWith(
            '/a.cpp',
            formatted,
            expect.objectContaining({ confirmOverwrite: false })
        )
        expect(f.api.debug.start).toHaveBeenCalledWith(expect.objectContaining({ source: formatted }))
        expect(f.editor.updateOptions).toHaveBeenCalled()
        expect(f.editor.updateOptions.mock.calls.every(([options]: [any]) => options.readOnly === true)).toBe(true)
    })

    it('disables a breakpoint rather than guessing if formatting changes non-whitespace content', async () => {
        const debug = await import('./debug')
        f.state.breakpoints['/a.cpp'] = [{ line: 3, enabled: true, condition: 'T > 0' }]
        debug.renderBreakpoints()
        f.ref.lang.format.mockResolvedValueOnce([{ range: {}, text: 'int main() { return 0; }\n' }] as any)
        const { formatActive } = await import('./format')
        await formatActive()
        expect(f.state.breakpoints['/a.cpp']).toEqual([{ line: 2, enabled: false, condition: 'T > 0' }])
        expect(f.toast).toHaveBeenCalledWith(expect.stringContaining('已停用断点'), 'info', 6000)
    })
})
