import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CompileResult, ToolchainSettings } from '../../shared/judge'

const mocks = vi.hoisted(() => ({
    compile: vi.fn(),
    plan: vi.fn(),
    load: vi.fn(),
    lease: vi.fn(),
    hostBuild: vi.fn(),
    hostLaunch: vi.fn(),
    hold: vi.fn()
}))
vi.mock('../judge/compile', () => ({ compileSource: mocks.compile }))
vi.mock('../judge/flags', () => ({ buildPlanFor: mocks.plan }))
vi.mock('../judge/cache-lru', () => ({ holdCachePath: mocks.hold }))
vi.mock('../problem/store', () => ({ acquireProblemLease: mocks.lease, loadProblem: mocks.load }))
vi.mock('./host', () => ({ buildTerminalHost: mocks.hostBuild, launchTerminalHost: mocks.hostLaunch }))
import { TerminalManager } from './index'

const openView = vi.fn(async () => ({ close: vi.fn() }) as never)

const tools = { compiler: 'g++', flags: '-std=c++17 -O2', debugFlags: '-g' } as ToolchainSettings
const good: CompileResult = { ok: true, exe: 'program.exe', output: '', diagnostics: [], timeMs: 1, cached: false }
let dir: string,
    manager: TerminalManager,
    close: () => void,
    onExit: Mock<(runId: string) => void>,
    release: Mock<() => void>
beforeEach(async () => {
    vi.clearAllMocks()
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-terminal-unit-'))
    release = vi.fn()
    onExit = vi.fn()
    mocks.compile.mockResolvedValue(good)
    mocks.load.mockResolvedValue({
        extraFlags: '-DVALUE=9',
        tests: [{ link: { input: path.join(dir, 'DO-NOT-READ.in') } }],
        fileIO: { enabled: true, input: 'data.in' }
    })
    mocks.plan.mockResolvedValue({ sources: ['grader.cpp'], includeDirs: ['headers'], flags: ['-DEXTRA'] })
    mocks.lease.mockResolvedValue(release)
    mocks.hold.mockReturnValue(release)
    mocks.hostBuild.mockResolvedValue({ exe: 'host.exe', release })
    mocks.hostLaunch.mockImplementation(async (_host, _exe, _cwd, _status, signal: AbortSignal) => {
        const closed = new Promise<void>((resolve) => {
            close = resolve
        })
        signal.addEventListener('abort', () => close(), { once: true })
        return { closed, stop: () => close() }
    })
    manager = new TerminalManager(() => tools, dir, openView, onExit)
})
afterEach(async () => {
    await manager.dispose()
    await fs.rm(dir, { recursive: true, force: true })
    vi.unstubAllEnvs()
})

it.skipIf(process.platform !== 'win32')(
    'compiles the current snapshot with problem flags and grader plan, then opens an empty working directory',
    async () => {
        const sourcePath = path.join(dir, 'main.cpp'),
            source = 'int main(){return VALUE;}'
        await fs.writeFile(path.join(dir, 'data.in'), 'must not be imported')
        const result = await manager.run({ operationId: 'terminal-1', sourcePath, source })
        expect(result).toMatchObject({ runId: 'terminal-1', compile: good, launched: true })
        expect(mocks.compile).toHaveBeenCalledWith(
            sourcePath,
            source,
            tools,
            false,
            '-DVALUE=9',
            expect.any(AbortSignal),
            [],
            undefined,
            { sources: ['grader.cpp'], includeDirs: ['headers'], flags: ['-DEXTRA'] }
        )
        const cwd = mocks.hostLaunch.mock.calls[0][2]
        expect(await fs.readdir(cwd)).toEqual([])
        expect(release).not.toHaveBeenCalled()
        close()
        await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith('terminal-1'))
        expect(await fs.stat(path.dirname(cwd)).catch(() => undefined)).toBeUndefined()
        expect(release).toHaveBeenCalledTimes(3)
    }
)

it.skipIf(process.platform !== 'win32')(
    'returns compilation diagnostics without launching a terminal or reading input files',
    async () => {
        const compile: CompileResult = {
            ...good,
            ok: false,
            exe: undefined,
            output: 'main.cpp:1: error: invalid',
            diagnostics: [{ line: 1, column: 1, severity: 'error', message: 'invalid' }]
        }
        mocks.compile.mockResolvedValue(compile)
        expect(await manager.run({ sourcePath: path.join(dir, 'main.cpp'), source: 'bad' })).toMatchObject({
            compile,
            launched: false
        })
        expect(mocks.hostBuild).not.toHaveBeenCalled()
        expect(mocks.hostLaunch).not.toHaveBeenCalled()
        expect(release).toHaveBeenCalledOnce()
    }
)

it.skipIf(process.platform !== 'win32')(
    'cancels an active compilation by operation id and allows an immediate retry',
    async () => {
        let entered: () => void
        const started = new Promise<void>((resolve) => {
            entered = resolve
        })
        mocks.compile.mockImplementationOnce(async (_src, _source, _settings, _debug, _extra, signal: AbortSignal) => {
            entered()
            await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
            return { ...good, ok: false, exe: undefined, output: 'Stopped' }
        })
        const pending = manager.run({
            operationId: 'cancel-compile',
            sourcePath: path.join(dir, 'main.cpp'),
            source: 'int main(){}'
        })
        await started
        await manager.stop('cancel-compile')
        expect(await pending).toMatchObject({
            runId: 'cancel-compile',
            launched: false,
            cancelled: true,
            compile: { ok: false, output: 'Stopped' }
        })
        expect(mocks.hostLaunch).not.toHaveBeenCalled()
        expect(
            (
                await manager.run({
                    operationId: 'cancel-compile',
                    sourcePath: path.join(dir, 'main.cpp'),
                    source: 'int main(){}'
                })
            ).launched
        ).toBe(true)
    }
)

it.skipIf(process.platform !== 'win32')(
    'stops only the named terminal and disposes all remaining consoles',
    async () => {
        const closers: (() => void)[] = []
        mocks.hostLaunch.mockImplementation(async (_host, _exe, _cwd, _status, signal: AbortSignal) => {
            const closed = new Promise<void>((resolve) => {
                closers.push(resolve)
                signal.addEventListener('abort', () => resolve(), { once: true })
            })
            return { closed, stop: closers.at(-1) }
        })
        const req = { sourcePath: path.join(dir, 'main.cpp'), source: 'int main(){}' }
        await manager.run({ ...req, operationId: 'one' })
        await manager.run({ ...req, operationId: 'two' })
        await manager.stop('one')
        expect(onExit).toHaveBeenCalledTimes(1)
        expect(onExit).toHaveBeenCalledWith('one')
        await manager.dispose()
        expect(onExit).toHaveBeenCalledWith('two')
        await expect(manager.run(req)).rejects.toThrow('disposed')
    }
)

it.skipIf(process.platform !== 'win32')(
    'does not report a launched terminal when cancellation races its startup',
    async () => {
        let stopping: Promise<void> | undefined
        mocks.hostLaunch.mockImplementationOnce(async () => {
            stopping = manager.stop('startup-race')
            return { closed: Promise.resolve(), stop: vi.fn() }
        })
        const result = await manager.run({
            operationId: 'startup-race',
            sourcePath: path.join(dir, 'main.cpp'),
            source: 'int main(){}'
        })
        await stopping
        expect(result).toMatchObject({ launched: false, cancelled: true })
        expect(onExit).toHaveBeenCalledOnce()
    }
)

it.skipIf(process.platform !== 'win32')(
    'reports terminal host failures while retaining successful solution compilation',
    async () => {
        mocks.hostLaunch.mockRejectedValueOnce(new Error('Windows terminal unavailable'))
        expect(await manager.run({ sourcePath: path.join(dir, 'main.cpp'), source: 'int main(){}' })).toMatchObject({
            compile: good,
            launched: false,
            error: 'Windows terminal unavailable'
        })
        expect((await fs.readdir(dir)).filter((file) => file.startsWith('run-'))).toEqual([])
    }
)

it.skipIf(process.platform !== 'win32')(
    'rejects a relative runtime directory before compiler or filesystem work',
    async () => {
        manager = new TerminalManager(() => tools, 'relative-root', openView)
        expect(await manager.run({ sourcePath: path.join(dir, 'main.cpp'), source: 'int main(){}' })).toMatchObject({
            launched: false,
            error: expect.stringContaining('绝对路径')
        })
        expect(mocks.compile).not.toHaveBeenCalled()
        expect(mocks.lease).not.toHaveBeenCalled()
    }
)
