import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { runInteractive } from './interactive'
import { killTree, launch } from './process'
import type { ToolchainSettings } from '../../shared/judge'
vi.mock('./runner', () => ({ getPassthroughRunner: vi.fn(async () => undefined) }))
vi.mock('./process', async (original) => ({
    ...(await original<typeof import('./process')>()),
    launch: vi.fn(),
    killTree: vi.fn()
}))
function child() {
    return Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough()
    })
}
let user: ReturnType<typeof child>, interactor: ReturnType<typeof child>
const options = () => ({
    exe: 'test-user',
    interactor: 'test-interactor',
    scratch: '.',
    testId: '1',
    input: 'input',
    output: 'output',
    answer: 'answer',
    timeLimit: 20_000,
    signal: new AbortController().signal,
    tc: { outputLimitBytes: 1024, displayLimitChars: 1024 } as ToolchainSettings
})
beforeEach(() => {
    vi.useFakeTimers()
    user = child()
    interactor = child()
    vi.mocked(launch)
        .mockReturnValueOnce(user as never)
        .mockReturnValueOnce(interactor as never)
    vi.mocked(killTree).mockImplementation((item) => {
        queueMicrotask(() => item.emit('close', 1, null))
    })
})
afterEach(() => {
    vi.useRealTimers()
    vi.resetAllMocks()
})
it('lets an interactor accompany a valid program beyond ten seconds', async () => {
    const task = runInteractive(options())
    await vi.advanceTimersByTimeAsync(12_000)
    interactor.emit('close', 0)
    user.emit('close', 0)
    expect(await task).toMatchObject({ verdict: 'AC' })
})
it('limits interactor finalization after the contestant exits', async () => {
    const task = runInteractive(options())
    await vi.advanceTimersByTimeAsync(0)
    user.emit('close', 0)
    await vi.advanceTimersByTimeAsync(1001)
    expect(await task).toMatchObject({ verdict: 'SE', checkerMessage: expect.stringContaining('1000 ms') })
})
