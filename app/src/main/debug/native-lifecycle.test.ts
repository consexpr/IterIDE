import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
import type { MITuple } from './mi'
import type { DebugBuild } from './build'
import type { ToolchainSettings } from '../../shared/judge'
const mocked = vi.hoisted(() => ({ command: vi.fn(), dispose: vi.fn(), clients: [] as EventEmitter[] }))
vi.mock('./mi-client', () => ({
    MIClient: class extends EventEmitter {
        command = mocked.command
        dispose = mocked.dispose
        inferiorPids: number[] = []
        interrupt() {}
        constructor() {
            super()
            mocked.clients.push(this)
        }
    }
}))
vi.mock('../toolchain', () => ({ resolveTool: () => ({ command: 'owned-gdb' }) }))
import { NativeDebugger } from './native'
beforeEach(() => {
    vi.resetAllMocks()
    mocked.clients.length = 0
    mocked.dispose.mockResolvedValue(undefined)
})
const native = () =>
    new NativeDebugger(
        { cwd: '.', dir: '.', sourcePath: 'main.cpp' } as DebugBuild,
        {} as ToolchainSettings,
        undefined,
        () => {},
        () => {}
    )

it('does not run queued symbol requests after dispose and joins repeated cleanup', async () => {
    const debug = native()
    let answer!: (tuple: MITuple) => void
    mocked.command.mockImplementationOnce(
        () =>
            new Promise<MITuple>((resolve) => {
                answer = resolve
            })
    )
    const first = debug.resolveLine('main.cpp', 1)
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'))
    const second = debug.resolveLine('main.cpp', 2)
    const results = Promise.allSettled([first, second])
    const disposing = debug.dispose()
    expect(debug.dispose()).toBe(disposing)
    answer({})
    expect((await results)[1]).toMatchObject({
        status: 'rejected',
        reason: expect.objectContaining({ message: '调试已停止' })
    })
    await disposing
    expect(mocked.command).toHaveBeenCalledOnce()
    expect(mocked.dispose).toHaveBeenCalledOnce()
    await expect(debug.query(0, 0, 'x')).rejects.toThrow('已停止')
})
it('bounds native work while the current GDB request is held', async () => {
    const debug = native()
    let answer!: (tuple: MITuple) => void
    mocked.command.mockImplementationOnce(
        () =>
            new Promise<MITuple>((resolve) => {
                answer = resolve
            })
    )
    const work = Array.from({ length: 65 }, (_, index) => debug.resolveLine('main.cpp', index + 1))
    const results = Promise.allSettled(work)
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'))
    const disposing = debug.dispose()
    answer({})
    expect((await results).at(-1)).toMatchObject({
        status: 'rejected',
        reason: expect.objectContaining({ message: expect.stringContaining('请求过多') })
    })
    await disposing
})
it('reports malformed Python completion markers as request errors without throwing from the protocol listener', async () => {
    const debug = native()
    debug.python = true
    mocked.command.mockResolvedValue({})
    const seeking = debug.seek(0)
    const failed = expect(seeking).rejects.toThrow('无效的 GDB 完成响应')
    await vi.waitFor(() => expect(mocked.command).toHaveBeenCalled())
    expect(() => mocked.clients[0].emit('record', { kind: 'console', text: 'ITER_DONE_1:{bad' })).not.toThrow()
    await failed
    expect(mocked.clients[0].listenerCount('closed')).toBe(1)
    await debug.dispose()
})
it('disables inferior calls only for automatic inspection and restores the previous GDB setting', async () => {
    const debug = native()
    // Already at this immutable snapshot: the test concerns evaluation, without replaying a program.
    const seeker = native()
    Object.assign(seeker, { nativeIndex: 0 })
    Object.assign(debug, { seeker: Promise.resolve(seeker) })
    mocked.command.mockImplementation(async (command: string) =>
        command === '-gdb-show may-call-functions'
            ? { value: 'off' }
            : command.startsWith('-var-create')
              ? { name: 'v', value: '4', type: 'int', numchild: '0' }
              : {}
    )
    const result = await debug.query(0, 0, 'x + 1', [], true)
    expect(result.value).toBe('4')
    expect(mocked.command.mock.calls.map((call) => call[0])).toEqual([
        '-gdb-show may-call-functions',
        '-gdb-set may-call-functions off',
        '-stack-select-frame 0',
        '-var-create - * "x + 1"',
        '-gdb-set may-call-functions off'
    ])
    await expect(debug.query(0, 0, 'x++', [], true)).rejects.toThrow('只读表达式')
    await debug.dispose()
})

it('does not queue live operations behind an isolated historical query', async () => {
    const debug = native(),
        seeker = native()
    let complete!: (node: { name: string; value: string; hasChildren: boolean }) => void
    const queryAt = vi.fn(
        () =>
            new Promise((resolve) => {
                complete = resolve
            })
    )
    Object.assign(debug, { seeker: Promise.resolve(seeker) })
    Object.assign(seeker, { queryAt })
    mocked.command.mockResolvedValue({})
    const query = debug.query(0, 0, 'a[5]')
    try {
        await vi.waitFor(() => expect(queryAt).toHaveBeenCalledOnce())
        await debug.resolveLine('main.cpp', 7)
        expect(mocked.command).toHaveBeenCalledWith(expect.stringContaining('-break-insert'))
    } finally {
        complete({ name: 'a[5]', value: '5', hasChildren: false })
        await query
        await debug.dispose()
    }
})
