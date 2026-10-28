import { beforeEach, describe, expect, it, vi } from 'vitest'

const f = vi.hoisted(() => {
    const compile = { ok: true, output: '', diagnostics: [], timeMs: 1, cached: false }
    const api = {
        run: vi.fn(async (req: any) => ({ runId: req.operationId, compile, launched: true })),
        stop: vi.fn(async (_id: string) => {}),
        onExit: vi.fn((_cb: (event: { runId: string }) => void) => () => {})
    }
    let state: any
    return {
        api,
        compile,
        get state() {
            return state
        },
        set state(value) {
            state = value
        },
        save: vi.fn(async (_path: string) => {}),
        isClosing: vi.fn(() => false),
        flush: vi.fn(async (_path: string) => {}),
        toast: vi.fn()
    }
})
vi.mock('../state/app', () => ({
    store: {
        get: () => f.state,
        set: (patch: any) => {
            f.state = { ...f.state, ...patch }
        }
    },
    updateFile: (path: string, patch: any) => {
        f.state.files = f.state.files.map((file: any) => (file.path === path ? { ...file, ...patch } : file))
    },
    toast: f.toast
}))
vi.mock('./files', () => ({ autoPersist: f.save, isFileTransitioning: f.isClosing }))
vi.mock('./problemWrites', () => ({ flushProblemWrites: f.flush }))

beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    f.state = {
        activePath: 'D:/code/a.cpp',
        settings: { autoSave: false },
        closing: false,
        debug: {},
        files: [
            {
                path: 'D:/code/a.cpp',
                model: { isDisposed: () => false, getValue: () => 'unsaved source' },
                dirty: true,
                terminalRunId: null,
                terminalPending: false
            }
        ]
    }
    f.api.run.mockImplementation(async (req) => ({ runId: req.operationId, compile: f.compile, launched: true }))
    f.api.stop.mockResolvedValue(undefined)
    f.isClosing.mockReturnValue(false)
    vi.stubGlobal('window', { iter: { terminal: f.api } })
})

describe('terminal actions', () => {
    it('runs an unsaved editor snapshot without requiring test cases', async () => {
        const { runTerminal, listenTerminal } = await import('./terminal')
        listenTerminal()
        await runTerminal()
        const request = f.api.run.mock.calls[0][0]
        expect(request).toMatchObject({ sourcePath: 'D:/code/a.cpp', source: 'unsaved source' })
        expect(f.save).toHaveBeenCalledWith('D:/code/a.cpp')
        expect(f.state.files[0]).toMatchObject({
            terminalRunId: request.operationId,
            terminalPending: false,
            compile: f.compile
        })
        f.api.onExit.mock.calls[0][0]({ runId: request.operationId })
        expect(f.state.files[0].terminalRunId).toBeNull()
    })

    it('stops an in-flight compiler and ignores its stale completion', async () => {
        const { runTerminal, stopTerminal } = await import('./terminal')
        let finish!: (result: any) => void
        f.api.run.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve
                })
        )
        const running = runTerminal()
        await vi.waitFor(() => expect(f.api.run).toHaveBeenCalled())
        const id = f.api.run.mock.calls[0][0].operationId
        const stopping = stopTerminal()
        expect(f.api.stop).toHaveBeenCalledWith(id)
        finish({ runId: id, compile: f.compile, launched: false, cancelled: true })
        await Promise.all([running, stopping])
        expect(f.state.files[0]).toMatchObject({ terminalRunId: null, terminalPending: false })
        expect(f.toast).not.toHaveBeenCalled()
    })

    it('shows compiler errors and clears run ownership', async () => {
        const { runTerminal } = await import('./terminal')
        const compile = { ...f.compile, ok: false, output: 'syntax error' }
        f.api.run.mockResolvedValueOnce({ runId: 'failed', compile, launched: false })
        await runTerminal()
        expect(f.state.files[0]).toMatchObject({ terminalRunId: null, terminalPending: false, compile })
        expect(f.state.rightView).toBe('tests')
        expect(f.toast).toHaveBeenCalledWith('编译错误', 'error', 6000)
    })

    it('does not start a console if cancelled while waiting for save', async () => {
        const { runTerminal, stopTerminal } = await import('./terminal')
        f.state.settings.autoSave = true
        let saved!: () => void
        f.save.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    saved = resolve
                })
        )
        const running = runTerminal()
        await vi.waitFor(() => expect(f.save).toHaveBeenCalled())
        const stopping = stopTerminal()
        saved()
        await Promise.all([running, stopping])
        expect(f.api.run).not.toHaveBeenCalled()
        expect(f.state.files[0].terminalRunId).toBeNull()
    })

    it('keeps a newer console stoppable when an older stop completes late', async () => {
        const { runTerminal, stopTerminal } = await import('./terminal')
        await runTerminal()
        let stopped!: () => void
        f.api.stop.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    stopped = resolve
                })
        )
        const oldStop = stopTerminal()
        await runTerminal()
        const newerId = f.state.files[0].terminalRunId
        stopped()
        await oldStop
        expect(f.state.files[0].terminalRunId).toBe(newerId)
        await stopTerminal()
        expect(f.api.stop).toHaveBeenLastCalledWith(newerId)
        expect(f.state.files[0].terminalRunId).toBeNull()
    })

    it('does not start a terminal while the file is closing', async () => {
        const { runTerminal } = await import('./terminal')
        f.isClosing.mockReturnValue(true)
        await runTerminal()
        expect(f.api.run).not.toHaveBeenCalled()
    })

    it('closes a stale launched terminal if its model disappeared while compiling', async () => {
        const { runTerminal } = await import('./terminal')
        let finish!: (result: any) => void
        f.api.run.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve
                })
        )
        const running = runTerminal()
        await vi.waitFor(() => expect(f.api.run).toHaveBeenCalled())
        const runId = f.api.run.mock.calls[0][0].operationId
        f.state.files = []
        finish({ runId, compile: f.compile, launched: true })
        await running
        expect(f.api.stop).toHaveBeenCalledWith(runId)
    })
})
