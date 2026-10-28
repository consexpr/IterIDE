import { describe, expect, it, vi } from 'vitest'
import { DebugStepGate } from './debugStepGate'

function deferred() {
    let resolve!: () => void, reject!: (error: Error) => void
    const promise = new Promise<void>((done, fail) => {
        resolve = done
        reject = fail
    })
    return { promise, resolve, reject }
}
const flush = async (): Promise<void> => {
    await Promise.resolve()
    await Promise.resolve()
}

describe('debug keyboard step backpressure', () => {
    it('drops held-F10 repeats without running queued steps after keyup', async () => {
        const gate = new DebugStepGate(),
            step = deferred(),
            onError = vi.fn()
        const work = vi.fn(() => step.promise)
        expect(gate.run('stepOver', work, onError)).toBe(true)
        for (let repeat = 0; repeat < 1000; repeat++) expect(gate.run('stepOver', work, onError)).toBe(false)
        expect(work).toHaveBeenCalledOnce()
        step.resolve()
        await flush()
        expect(gate.busy).toBe(false)
        expect(work).toHaveBeenCalledOnce()
        expect(onError).not.toHaveBeenCalled()
    })

    it('accepts the next OS repeat only after the previous step completes', async () => {
        const gate = new DebugStepGate(),
            first = deferred(),
            second = deferred(),
            onError = vi.fn()
        expect(gate.run('stepOver', () => first.promise, onError)).toBe(true)
        first.resolve()
        await flush()
        expect(gate.run('stepOver', () => second.promise, onError)).toBe(true)
        expect(gate.busy).toBe(true)
        second.resolve()
        await flush()
        expect(gate.busy).toBe(false)
    })

    it.each(['stop', 'pause', 'restart', 'seek', 'frame', 'new session'])(
        'invalidates old work after %s without letting its finally unlock a newer step',
        async () => {
            const gate = new DebugStepGate(),
                oldStep = deferred(),
                newStep = deferred(),
                onError = vi.fn()
            gate.run('stepOver', () => oldStep.promise, onError)
            gate.invalidate()
            expect(gate.busy).toBe(false)
            expect(gate.run('stepOver', () => newStep.promise, onError)).toBe(true)
            oldStep.resolve()
            await flush()
            expect(gate.busy).toBe(true)
            expect(gate.run('stepOver', async () => {}, onError)).toBe(false)
            newStep.resolve()
            await flush()
            expect(gate.busy).toBe(false)
        }
    )

    it('discards an obsolete step error without hiding a newer pending command', async () => {
        const gate = new DebugStepGate(),
            oldStep = deferred(),
            current = deferred(),
            onError = vi.fn()
        gate.run('stepOver', () => oldStep.promise, onError)
        gate.invalidate()
        gate.run('stepOver', () => current.promise, onError)
        oldStep.reject(new Error('previous frame'))
        await flush()
        expect(onError).not.toHaveBeenCalled()
        expect(gate.busy).toBe(true)
        current.resolve()
        await flush()
    })

    it.each(['stepBack', 'stepIn', 'stepOut'])(
        'immediately replaces held F10 with %s and keeps its own pending identity',
        async (command) => {
            const gate = new DebugStepGate(),
                heldF10 = deferred(),
                replacement = deferred(),
                onError = vi.fn()
            gate.run('stepOver', () => heldF10.promise, onError)
            expect(gate.isBusy('stepOver')).toBe(true)
            expect(gate.run(command, () => replacement.promise, onError)).toBe(true)
            expect(gate.isBusy(command)).toBe(true)
            expect(gate.isBusy('stepOver')).toBe(false)
            heldF10.reject(new Error('superseded step'))
            await flush()
            expect(onError).not.toHaveBeenCalled()
            expect(gate.isBusy(command)).toBe(true)
            replacement.resolve()
            await flush()
            expect(gate.busy).toBe(false)
        }
    )

    it('reports current errors once and allows a fresh step afterward', async () => {
        const gate = new DebugStepGate(),
            step = deferred(),
            onError = vi.fn(),
            error = new Error('cannot step')
        gate.run('stepOver', () => step.promise, onError)
        step.reject(error)
        await flush()
        expect(onError).toHaveBeenCalledExactlyOnceWith(error)
        expect(gate.busy).toBe(false)
        expect(gate.run('stepOver', async () => {}, onError)).toBe(true)
        await flush()
    })

    it('also releases a synchronously failing command', async () => {
        const gate = new DebugStepGate(),
            onError = vi.fn(),
            error = new Error('IPC unavailable')
        expect(
            gate.run(
                'stepOver',
                () => {
                    throw error
                },
                onError
            )
        ).toBe(true)
        await flush()
        expect(onError).toHaveBeenCalledExactlyOnceWith(error)
        expect(gate.busy).toBe(false)
    })
})
