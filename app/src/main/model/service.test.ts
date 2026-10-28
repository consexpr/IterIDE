import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelService } from './service'
import type { ModelRequest } from '../../shared/model'

class FakeWorker extends EventEmitter {
    postMessage = vi.fn((message: { type: string; request?: ModelRequest }) => {
        if (message.type === 'dispose') queueMicrotask(() => this.emit('exit', 0))
    })
    terminate = vi.fn(async () => 0)
}
const request = (id: string): ModelRequest => ({
    id,
    source: 'ab',
    cursor: 2,
    prefix: 'ab',
    standard: 'gnu++17',
    candidates: [
        { label: 'abc', kind: 6 },
        { label: 'abcd', kind: 6 }
    ]
})
const result = { order: [1, 0], probabilities: [0.2, 0.8] }
const services: ModelService[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.dispose()))
    vi.useRealTimers()
})
function fixture() {
    let enabled = true
    const workers: FakeWorker[] = []
    const unavailable = vi.fn()
    const factory = vi.fn(() => {
        const worker = new FakeWorker()
        workers.push(worker)
        return worker as never
    })
    const service = new ModelService({
        assets: 'assets',
        library: 'clang',
        scratch: 'scratch',
        workerFile: 'worker',
        enabled: () => enabled,
        unavailable,
        createWorker: factory
    })
    services.push(service)
    return {
        service,
        workers,
        factory,
        unavailable,
        enable(value: boolean) {
            enabled = value
            service.prepare()
        }
    }
}

describe('Model worker lifecycle and bounded requests', () => {
    it('does no work while disabled, warms in background and ranks only when ready', async () => {
        const f = fixture()
        f.enable(false)
        expect(await f.service.rank(request('off'))).toBeNull()
        expect(f.factory).not.toHaveBeenCalled()
        f.enable(true)
        expect(await f.service.rank(request('cold'))).toBeNull()
        f.workers[0].emit('message', { type: 'ready' })
        const ranked = f.service.rank(request('on'))
        f.workers[0].emit('message', { type: 'result', id: 'on', result })
        expect(await ranked).toEqual(result)
    })

    it('keeps only the newest queued request and rejects duplicate ids', async () => {
        const f = fixture()
        f.enable(true)
        const worker = f.workers[0]
        worker.emit('message', { type: 'ready' })
        const a = f.service.rank(request('a')),
            b = f.service.rank(request('b')),
            c = f.service.rank(request('c'))
        expect(await b).toBeNull()
        expect(await f.service.rank(request('a'))).toBeNull()
        expect(worker.postMessage).toHaveBeenCalledTimes(1)
        worker.emit('message', { type: 'result', id: 'a', result })
        expect(await a).toEqual(result)
        expect(worker.postMessage.mock.calls.at(-1)![0].request!.id).toBe('c')
        worker.emit('message', { type: 'result', id: 'c', result })
        expect(await c).toEqual(result)
    })

    it('times out promptly, cancels pending work and kills a stuck worker', async () => {
        const f = fixture()
        f.enable(true)
        const worker = f.workers[0]
        worker.emit('message', { type: 'ready' })
        const a = f.service.rank(request('a'))
        await vi.advanceTimersByTimeAsync(120)
        expect(await a).toBeNull()
        const b = f.service.rank(request('b'))
        f.service.cancel('b')
        expect(await b).toBeNull()
        await vi.advanceTimersByTimeAsync(880)
        expect(worker.terminate).toHaveBeenCalledTimes(1)
        expect(f.unavailable).toHaveBeenCalledTimes(1)
    })

    it('drops malformed replies and ignores a disposed worker after re-enabling', async () => {
        const f = fixture()
        f.enable(true)
        const first = f.workers[0]
        first.emit('message', { type: 'ready' })
        const a = f.service.rank(request('a'))
        first.emit('message', { type: 'result', id: 'a', result: { order: [0, 0], probabilities: [0.5, 0.5] } })
        expect(await a).toBeNull()
        f.enable(false)
        f.enable(true)
        const second = f.workers[1]
        second.emit('message', { type: 'ready' })
        const b = f.service.rank(request('b'))
        first.emit('message', { type: 'result', id: 'b', result })
        expect(second.postMessage).toHaveBeenCalledTimes(1)
        second.emit('message', { type: 'result', id: 'b', result })
        expect(await b).toEqual(result)
    })

    it('settles all callers on error, disable or shutdown without a retry loop', async () => {
        const f = fixture()
        f.enable(true)
        const worker = f.workers[0]
        worker.emit('message', { type: 'ready' })
        const a = f.service.rank(request('a')),
            b = f.service.rank(request('b'))
        worker.emit('error', Error('broken'))
        expect(await a).toBeNull()
        expect(await b).toBeNull()
        expect(await f.service.rank(request('c'))).toBeNull()
        expect(f.factory).toHaveBeenCalledTimes(1)
        await f.service.dispose()
        expect(await f.service.rank(request('after'))).toBeNull()
    })

    it('drains WASM gracefully and waits for workers from a quick disable/enable cycle', async () => {
        const f = fixture()
        f.enable(true)
        const first = f.workers[0]
        first.emit('message', { type: 'ready' })
        f.enable(false)
        f.enable(true)
        const second = f.workers[1]
        second.emit('message', { type: 'ready' })
        const active = f.service.rank(request('closing'))
        await f.service.dispose()
        expect(await active).toBeNull()
        expect(first.postMessage).toHaveBeenCalledWith({ type: 'dispose' })
        expect(second.postMessage).toHaveBeenCalledWith({ type: 'dispose' })
        expect(first.terminate).not.toHaveBeenCalled()
        expect(second.terminate).not.toHaveBeenCalled()
    })
})
