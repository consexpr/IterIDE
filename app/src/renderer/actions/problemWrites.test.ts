import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeferredWrite } from './problemWrites'

function deferred() {
    let resolve!: () => void, reject!: (error: Error) => void
    const promise = new Promise<void>((yes, no) => {
        resolve = yes
        reject = no
    })
    return { promise, resolve, reject }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('debounced persistence ownership', () => {
    it('serializes writes and drains edits accepted while the first write is in flight', async () => {
        const gate = deferred(),
            error = vi.fn()
        const write = vi.fn(async (_value: { text: string }) => {}).mockImplementationOnce(() => gate.promise)
        const queue = new DeferredWrite(write, (_old, next) => next, error)
        queue.enqueue({ text: 'first' }, 400)
        await vi.advanceTimersByTimeAsync(400)
        queue.enqueue({ text: 'last' }, 400)
        const flushed = queue.flush()
        expect(write).toHaveBeenCalledTimes(1)
        gate.resolve()
        await flushed
        expect(write.mock.calls.map((args) => args[0])).toEqual([{ text: 'first' }, { text: 'last' }])
        expect(error).not.toHaveBeenCalled()
        expect(queue.idle).toBe(true)
    })

    it('retains failed patches and retries them together with later edits', async () => {
        const gate = deferred()
        const write = vi.fn(async (_value: { a?: number; b?: number }) => {}).mockImplementationOnce(() => gate.promise)
        const queue = new DeferredWrite(write, (old, next) => ({ ...old, ...next }), vi.fn())
        queue.enqueue({ a: 1 }, 400)
        const first = queue.flush()
        const rejected = expect(first).rejects.toThrow('disk full')
        await Promise.resolve()
        queue.enqueue({ b: 2 }, 400)
        gate.reject(new Error('disk full'))
        await rejected
        expect(queue.overlay).toEqual({ a: 1, b: 2 })
        await queue.flush()
        expect(write.mock.calls.at(-1)?.[0]).toEqual({ a: 1, b: 2 })
        expect(queue.idle).toBe(true)
    })

    it('blocks new edits before waiting for an uncancellable write, and can restore a failed deletion', async () => {
        const gate = deferred(),
            write = vi.fn(() => gate.promise)
        const queue = new DeferredWrite<string>(write, (_old, next) => next, vi.fn())
        queue.enqueue('inflight', 400)
        await vi.advanceTimersByTimeAsync(400)
        queue.enqueue('latest', 400)
        let deleted = false
        const deleting = queue.beginDelete().then(() => {
            deleted = true
        })
        expect(queue.blocked).toBe(true)
        expect(() => queue.enqueue('must not write', 0)).toThrow('正在删除')
        await Promise.resolve()
        expect(deleted).toBe(false)
        gate.resolve()
        await deleting
        await vi.advanceTimersByTimeAsync(500)
        expect(write).toHaveBeenCalledTimes(1)
        queue.restoreAfterDeleteFailure()
        await queue.flush()
        expect(write).toHaveBeenLastCalledWith('latest', expect.any(Function))
    })
})
