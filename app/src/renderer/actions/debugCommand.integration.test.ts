import { afterEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
    state: {} as any,
    command: vi.fn(),
    seek: vi.fn(),
    selectFrame: vi.fn(),
    locals: vi.fn(),
    stack: vi.fn(),
    toast: vi.fn(),
    hideHover: vi.fn()
}))
vi.mock('../editor/instance', () => ({
    editorRef: {
        editor: { getAction: () => ({ run: runtime.hideHover }) },
        lang: null
    }
}))
vi.mock('../editor/monaco', () => ({ monaco: {} }))
vi.mock('../state/app', () => ({
    activeFile: () => null,
    emptyDebug: () => ({ state: { status: 'idle' } }),
    toast: runtime.toast,
    isDebugging: () => !['idle', 'error'].includes(runtime.state.debug.state.status),
    store: {
        get: () => runtime.state,
        set: (patch: any) => {
            runtime.state = { ...runtime.state, ...(typeof patch === 'function' ? patch(runtime.state) : patch) }
        }
    }
}))
vi.mock('./files', () => ({ activate: vi.fn(), saveFile: vi.fn() }))
vi.mock('./problemWrites', () => ({ flushProblemWrites: vi.fn() }))
vi.mock('./judge', () => ({ stopRun: vi.fn() }))

function deferred() {
    let resolve!: () => void, reject!: (error: Error) => void
    const promise = new Promise<void>((done, fail) => {
        resolve = done
        reject = fail
    })
    return { promise, resolve, reject }
}
const flush = async (): Promise<void> => {
    for (let n = 0; n < 8; n++) await Promise.resolve()
}
async function fixture() {
    vi.resetModules()
    runtime.command.mockReset().mockResolvedValue(undefined)
    runtime.seek.mockReset().mockResolvedValue(undefined)
    runtime.selectFrame.mockReset().mockResolvedValue(undefined)
    runtime.locals.mockReset().mockResolvedValue([])
    runtime.stack.mockReset().mockResolvedValue([])
    runtime.toast.mockReset()
    runtime.hideHover.mockReset().mockResolvedValue(undefined)
    runtime.state = {
        activePath: 'sample.cpp',
        files: [],
        debug: {
            state: { status: 'paused', stepIndex: 0, file: 'sample.cpp', line: 6, frame: 0, reason: 'step' },
            frame: 0,
            stack: [],
            path: 'sample.cpp'
        }
    }
    vi.stubGlobal('window', {
        iter: {
            debug: {
                command: runtime.command,
                seek: runtime.seek,
                selectFrame: runtime.selectFrame,
                locals: runtime.locals,
                stack: runtime.stack
            }
        }
    })
    return import('./debug')
}
afterEach(() => {
    vi.unstubAllGlobals()
})

describe('renderer debug command dispatch', () => {
    it('sends one IPC for held F10/legacy next and does no queued work after release', async () => {
        const actions = await fixture(),
            step = deferred()
        runtime.command.mockImplementationOnce(() => step.promise)
        actions.debugCommand('stepOver')
        for (let repeat = 0; repeat < 1000; repeat++) actions.debugCommand(repeat % 2 ? 'next' : 'stepOver')
        expect(runtime.command.mock.calls).toEqual([['stepOver']])
        expect(runtime.hideHover).toHaveBeenCalledOnce()
        step.resolve()
        await flush()
        expect(runtime.command).toHaveBeenCalledOnce()
        actions.debugCommand('next')
        await flush()
        expect(runtime.command.mock.calls).toEqual([['stepOver'], ['next']])
    })

    it('sends stepBack immediately while F10 waits and suppresses the old rejection', async () => {
        const actions = await fixture(),
            first = deferred(),
            reverse = deferred()
        runtime.command.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => reverse.promise)
        actions.debugCommand('stepOver')
        actions.debugCommand('stepBack')
        expect(runtime.command.mock.calls).toEqual([['stepOver'], ['stepBack']])
        first.reject(new Error('old step'))
        await flush()
        actions.debugCommand('stepBack')
        expect(runtime.command).toHaveBeenCalledTimes(2)
        expect(runtime.toast).not.toHaveBeenCalled()
        reverse.resolve()
        await flush()
    })

    it.each(['pause', 'restart', 'seek', 'frame'])(
        'invalidates pending F10 through the actual %s action',
        async (navigation) => {
            const actions = await fixture(),
                old = deferred(),
                current = deferred()
            runtime.command.mockImplementationOnce(() => old.promise)
            actions.debugCommand('stepOver')
            if (navigation === 'seek') actions.seekDebug(1)
            else if (navigation === 'frame') await actions.selectFrame(1)
            else actions.debugCommand(navigation as 'pause' | 'restart')
            runtime.command.mockImplementationOnce(() => current.promise)
            actions.debugCommand('stepOver')
            const calls = runtime.command.mock.calls.filter((call) => call[0] === 'stepOver')
            expect(calls).toHaveLength(2)
            old.reject(new Error('obsolete navigation'))
            await flush()
            actions.debugCommand('stepOver')
            expect(runtime.command.mock.calls.filter((call) => call[0] === 'stepOver')).toHaveLength(2)
            expect(runtime.toast).not.toHaveBeenCalled()
            current.resolve()
            await flush()
        }
    )
})
