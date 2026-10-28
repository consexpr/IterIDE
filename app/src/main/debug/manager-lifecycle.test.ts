import { beforeEach, expect, it, vi } from 'vitest'
import { DebugManager } from './manager'
import { buildDebug, removeBuild } from './build'
import { acquireProblemLease } from '../problem/store'
import type { DebugStartRequest } from '../../shared/debug'
import type { ToolchainSettings } from '../../shared/judge'
import type { JudgeEngine } from '../judge/engine'
const state = vi.hoisted(() => ({ resolveStart: undefined as (() => void) | undefined, disposed: vi.fn() }))
vi.mock('./build', () => ({ buildDebug: vi.fn(), removeBuild: vi.fn() }))
vi.mock('../problem/store', () => ({ acquireProblemLease: vi.fn() }))
vi.mock('./session', () => ({
    DebugSession: class {
        async setBreakpoints() {}
        start() {
            return new Promise<void>((resolve) => {
                state.resolveStart = resolve
            })
        }
        async dispose() {
            state.disposed()
            state.resolveStart?.()
        }
    }
}))
const req = { sourcePath: 'test-main.cpp', source: '', breakpoints: [] } as DebugStartRequest
beforeEach(() => {
    vi.resetAllMocks()
    state.resolveStart = undefined
})
it('aborts and waits for an in-flight build before releasing its lease', async () => {
    const release = vi.fn()
    vi.mocked(acquireProblemLease).mockResolvedValue(release)
    vi.mocked(buildDebug).mockImplementation(
        async (_req, _tools, signal) =>
            new Promise((_resolve, reject) =>
                signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
            )
    )
    const manager = new DebugManager(
        {} as JudgeEngine,
        () => ({}) as ToolchainSettings,
        () => {}
    )
    const starting = manager.start(req)
    await vi.waitFor(() => expect(buildDebug).toHaveBeenCalledOnce())
    const disposing = manager.dispose()
    expect(manager.dispose()).toBe(disposing)
    await disposing
    await starting
    expect(release).toHaveBeenCalledOnce()
    await expect(manager.start(req)).rejects.toThrow('disposed')
})
it('joins initialization/recording shutdown and removes its build once', async () => {
    const release = vi.fn()
    vi.mocked(acquireProblemLease).mockResolvedValue(release)
    vi.mocked(buildDebug).mockResolvedValue({
        dir: 'owned-test-build',
        sourcePath: req.sourcePath,
        sourceFiles: [req.sourcePath]
    } as never)
    const manager = new DebugManager(
        {} as JudgeEngine,
        () => ({}) as ToolchainSettings,
        () => {}
    )
    const starting = manager.start(req)
    await vi.waitFor(() => expect(state.resolveStart).toBeTypeOf('function'))
    await manager.dispose()
    await starting
    expect(removeBuild).toHaveBeenCalledExactlyOnceWith('owned-test-build')
    expect(release).toHaveBeenCalledOnce()
})
it('propagates a transient build removal failure and retries cleanup on the next dispose', async () => {
    const release = vi.fn()
    vi.mocked(acquireProblemLease).mockResolvedValue(release)
    vi.mocked(buildDebug).mockResolvedValue({
        dir: 'owned-test-build',
        sourcePath: req.sourcePath,
        sourceFiles: [req.sourcePath]
    } as never)
    vi.mocked(removeBuild).mockRejectedValueOnce(new Error('EPERM')).mockResolvedValue(undefined)
    const manager = new DebugManager(
        {} as JudgeEngine,
        () => ({}) as ToolchainSettings,
        () => {}
    )
    const starting = manager.start(req)
    await vi.waitFor(() => expect(state.resolveStart).toBeTypeOf('function'))
    await expect(manager.dispose()).rejects.toThrow('EPERM')
    await starting
    await expect(manager.dispose()).resolves.toBeUndefined()
    expect(removeBuild).toHaveBeenCalledTimes(2)
    expect(release).toHaveBeenCalledOnce()
})
