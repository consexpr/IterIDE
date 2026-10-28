import { beforeEach, expect, it, vi } from 'vitest'
import type { DebugStartRequest } from '../../shared/debug'
import type { JudgeEngine } from '../judge/engine'
import type { ToolchainSettings } from '../../shared/judge'
import type { DebugBuild } from './build'
const mocked = vi.hoisted(() => ({
    build: vi.fn(),
    remove: vi.fn(),
    release: vi.fn(),
    command: vi.fn(),
    inspect: vi.fn(),
    evaluate: vi.fn(),
    dispose: vi.fn(),
    handlers: new Map<string, (...args: any[]) => any>()
}))
vi.mock('electron', () => ({
    app: { isPackaged: false, getAppPath: () => '.', getPath: () => '.', getVersion: () => 'test' },
    dialog: {},
    shell: {},
    ipcMain: {
        handle: (channel: string, fn: (...args: any[]) => any) => mocked.handlers.set(channel, fn),
        on: vi.fn()
    }
}))
vi.mock('../judge/engine', () => ({ JudgeEngine: class {} }))
vi.mock('../plugins/manager', () => ({
    PluginManager: class {
        async loadAll() {}
    }
}))
vi.mock('../lsp/clangd', () => ({ ClangdBridge: class {} }))
vi.mock('../sync', () => ({ SyncManager: class {} }))
vi.mock('./build', () => ({ buildDebug: mocked.build, removeBuild: mocked.remove }))
vi.mock('../problem/store', () => ({ acquireProblemLease: async () => mocked.release }))
vi.mock('./session', () => ({
    DebugSession: class {
        async start() {}
        async setBreakpoints() {}
        command = mocked.command
        inspect = mocked.inspect
        evaluate = mocked.evaluate
        dispose = mocked.dispose
    }
}))
import { DebugManager } from './manager'
import { registerIpc } from '../ipc'
import type { SettingsStore } from '../settings'
const request: DebugStartRequest = { sourcePath: 'main.cpp', source: 'int main(){}', breakpoints: [] }
beforeEach(() => {
    vi.resetAllMocks()
    mocked.handlers.clear()
    mocked.build.mockResolvedValue({ sourcePath: 'main.cpp', sourceFiles: ['main.cpp'], dir: 'owned-build' })
    mocked.dispose.mockResolvedValue(undefined)
    mocked.inspect.mockResolvedValue(null)
})
const manager = () =>
    new DebugManager(
        {} as JudgeEngine,
        () => ({}) as ToolchainSettings,
        () => {}
    )

it('rejects malformed replacement starts and commands while preserving the usable session', async () => {
    const debug = manager()
    try {
        await debug.start(request)
        await expect(debug.start({ ...request, breakpoints: null } as never)).rejects.toThrow('breakpoints')
        await expect(debug.command('unknown' as never)).rejects.toThrow('command')
        await debug.command('stepIn')
        expect(mocked.command).toHaveBeenCalledExactlyOnceWith('stepIn')
        expect(mocked.dispose).not.toHaveBeenCalled()
        expect(mocked.build).toHaveBeenCalledOnce()
    } finally {
        await debug.dispose()
    }
})
it('stops forwarding reads as soon as cleanup starts and makes repeated stops join cleanup', async () => {
    const debug = manager()
    await debug.start(request)
    let finish!: () => void
    mocked.dispose.mockImplementation(
        () =>
            new Promise<void>((resolve) => {
                finish = resolve
            })
    )
    const stop = debug.command('stop'),
        otherStop = debug.command('stop')
    try {
        expect(await debug.evaluate('x')).toBeNull()
        expect(await debug.inspect('x')).toBeNull()
        expect(await debug.locals()).toEqual([])
        await debug.command('restart')
        expect(mocked.evaluate).not.toHaveBeenCalled()
        expect(mocked.inspect).not.toHaveBeenCalled()
        expect(mocked.command).not.toHaveBeenCalled()
        expect(mocked.dispose).toHaveBeenCalledOnce()
    } finally {
        finish()
        mocked.dispose.mockResolvedValue(undefined)
        await Promise.all([stop, otherStop])
        await debug.dispose()
    }
    expect(mocked.remove).toHaveBeenCalledOnce()
    expect(mocked.release).toHaveBeenCalledOnce()
})
it('cancels rapid starts and stop during a deferred compile before starting the latest session', async () => {
    const builds: { sourcePath: string; finish: (build: DebugBuild) => void }[] = []
    mocked.build.mockImplementation(
        (req: DebugStartRequest, _tools, signal: AbortSignal) =>
            new Promise<DebugBuild>((resolve, reject) => {
                builds.push({ sourcePath: req.sourcePath, finish: resolve })
                signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
            })
    )
    const debug = manager()
    const first = debug.start({ ...request, sourcePath: 'first.cpp' })
    await vi.waitFor(() => expect(builds).toHaveLength(1))
    const second = debug.start({ ...request, sourcePath: 'second.cpp' })
    await vi.waitFor(() => expect(builds).toHaveLength(2))
    const stop = debug.command('stop')
    const latest = debug.start({ ...request, sourcePath: 'latest.cpp' })
    await vi.waitFor(() => expect(builds).toHaveLength(3))
    builds[2].finish({ sourcePath: 'latest.cpp', sourceFiles: ['latest.cpp'], dir: 'latest-build' } as DebugBuild)
    await Promise.all([first, second, stop, latest])
    await debug.command('stepIn')
    expect(mocked.command).toHaveBeenCalledExactlyOnceWith('stepIn')
    await debug.dispose()
    expect(mocked.release).toHaveBeenCalledTimes(3)
})
it('keeps automatic inspection separate from explicit evaluation', async () => {
    const debug = manager()
    try {
        await debug.start(request)
        await debug.inspect('x + 1')
        expect(await debug.inspect('x++')).toBeNull()
        await debug.evaluate('x++')
        expect(mocked.inspect).toHaveBeenCalledExactlyOnceWith('x + 1')
        expect(mocked.evaluate).toHaveBeenCalledExactlyOnceWith('x++')
    } finally {
        await debug.dispose()
    }
})
it('bounds direct inspect IPC floods, shares identical work, and drops results arriving after stop', async () => {
    const entry = 'file:///iter/renderer/index.html',
        mainFrame = { url: entry }
    const webContents = { mainFrame, isDestroyed: () => false, send: vi.fn() }
    registerIpc(
        () => ({ isDestroyed: () => false, webContents }) as any,
        { get: () => ({ toolchain: {} }), userDirs: () => ({ plugins: '.' }) } as unknown as SettingsStore,
        undefined,
        entry
    )
    const invoke = (channel: string, ...args: unknown[]) =>
        mocked.handlers.get(channel)!({ sender: webContents, senderFrame: mainFrame }, ...args)
    await invoke('debug:start', request)
    let answer!: (value: { value: string }) => void
    mocked.inspect.mockImplementation(
        () =>
            new Promise((resolve) => {
                answer = resolve
            })
    )
    const first = invoke('debug:inspect', 'x'),
        same = invoke('debug:inspect', 'x')
    const others = Array.from({ length: 1000 }, (_, index) => invoke('debug:inspect', `x + ${index}`))
    expect(await Promise.all(others)).toEqual(new Array(1000).fill(null))
    expect(mocked.inspect).toHaveBeenCalledExactlyOnceWith('x')
    await invoke('debug:evaluate', 'x++')
    expect(mocked.evaluate).toHaveBeenCalledExactlyOnceWith('x++')
    await invoke('debug:command', 'stop')
    answer({ value: 'stale' })
    expect(await first).toBeNull()
    expect(await same).toBeNull()
})
it('does not let an old inspection clear the next session inspection lock', async () => {
    const debug = manager()
    await debug.start(request)
    let oldAnswer!: (value: { value: string }) => void, newAnswer!: (value: { value: string }) => void
    mocked.inspect.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                oldAnswer = resolve
            })
    )
    const old = debug.inspect('x')
    await debug.command('stop')
    await debug.start(request)
    mocked.inspect.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                newAnswer = resolve
            })
    )
    const current = debug.inspect('y')
    oldAnswer({ value: 'old' })
    expect(await old).toBeNull()
    expect(await debug.inspect('z')).toBeNull()
    expect(mocked.inspect).toHaveBeenCalledTimes(2)
    newAnswer({ value: '7' })
    expect(await current).toEqual({ value: '7' })
    await debug.dispose()
})
