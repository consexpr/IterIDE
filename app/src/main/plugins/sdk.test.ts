import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import sdk from '../../../resources/sdk/panel.js?raw'

interface Request {
    type: string
    id: number
    method: string
    args: unknown[]
}
interface Bridge {
    onState(callback: (state: unknown) => void): () => void
    invoke(channel: string, ...args: unknown[]): Promise<unknown>
    getSource(): Promise<unknown>
    insertText(text: string): Promise<unknown>
    openFile(path: string): Promise<unknown>
    runTests(ids?: string[]): Promise<unknown>
    toast(text: string, kind?: string): Promise<unknown>
    setBadge(text: string | null): Promise<unknown>
}

function panel() {
    const requests: Request[] = []
    const parent = { postMessage: vi.fn((request: Request) => requests.push(request)) }
    let listener!: (event: { source: unknown; data: unknown }) => void
    const window = {
        parent,
        iter: undefined as unknown as Bridge,
        naven: undefined as unknown as Bridge,
        addEventListener: (_event: string, callback: typeof listener) => {
            listener = callback
        }
    }
    const variables = new Map<string, string>()
    const root = {
        dataset: {} as Record<string, string>,
        style: {
            colorScheme: '',
            setProperty: (key: string, value: string) => variables.set(key, value),
            removeProperty: (key: string) => variables.delete(key)
        }
    }
    const log = { error: vi.fn() }
    runInNewContext(sdk, { window, document: { documentElement: root }, setTimeout, clearTimeout, console: log })
    return {
        iter: window.iter,
        legacy: window.naven,
        parent,
        requests,
        root,
        variables,
        log,
        receive: (data: unknown, source: unknown = parent) => listener({ source, data })
    }
}

describe('panel bridge SDK', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('serializes every SDK method, correlates out-of-order replies and rejects only parent errors', async () => {
        const p = panel()
        expect(p.legacy).toBe(p.iter)
        const values = [
            p.iter.invoke('save', 'a.cpp', 'notes'),
            p.iter.getSource(),
            p.iter.insertText('text'),
            p.iter.openFile('a.cpp'),
            p.iter.runTests(),
            p.iter.runTests(['one']),
            p.iter.toast('ok'),
            p.iter.toast('failed', 'error'),
            p.iter.setBadge('2'),
            p.iter.setBadge(null)
        ]
        expect(p.requests.map(({ method, args }) => [method, args])).toEqual([
            ['invoke', ['save', 'a.cpp', 'notes']],
            ['getSource', []],
            ['insertText', ['text']],
            ['openFile', ['a.cpp']],
            ['runTests', []],
            ['runTests', [['one']]],
            ['toast', ['ok']],
            ['toast', ['failed', 'error']],
            ['setBadge', ['2']],
            ['setBadge', [null]]
        ])
        expect(new Set(p.requests.map((r) => r.id)).size).toBe(values.length)
        const first = p.requests[0]
        p.receive({ type: 'iter:reply', id: first.id, ok: true, value: 'spoofed' }, {})
        for (const request of [...p.requests].reverse()) {
            p.receive({ type: 'iter:reply', id: request.id, ok: true, value: request.method })
        }
        expect(await Promise.all(values)).toEqual(p.requests.map((r) => r.method))
        const failed = p.iter.invoke('fail')
        const rejection = expect(failed).rejects.toMatchObject({ message: 'bad input' })
        p.receive({ type: 'iter:reply', id: p.requests.at(-1)!.id, ok: false, error: { message: 'bad input' } })
        await rejection
        const legacy = expect(p.iter.invoke('legacy')).rejects.toMatchObject({ message: 'renderer error' })
        p.receive({ type: 'iter:reply', id: p.requests.at(-1)!.id, ok: false, error: 'renderer error' })
        await legacy
        const empty = p.iter.getSource()
        p.receive({ type: 'iter:reply', id: p.requests.at(-1)!.id, ok: true, value: null })
        expect(await empty).toBeNull()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('applies and replaces theme variables before notifying, replays cached state and unsubscribes', () => {
        const p = panel()
        const received = vi.fn(() => {
            expect(p.variables.get('--text')).toBe('#123')
        })
        const unsubscribe = p.iter.onState(received)
        const state = {
            file: null,
            theme: { id: 'test', kind: 'light', vars: { '--text': '#123', '--old': 'old', color: 'bad' } }
        }
        p.receive({ type: 'iter:state', state }, {})
        expect(received).not.toHaveBeenCalled()
        p.receive({ type: 'iter:state', state })
        expect(received).toHaveBeenCalledWith(state)
        expect(p.variables.has('color')).toBe(false)
        expect(p.root.dataset).toMatchObject({ theme: 'test', themeKind: 'light' })
        expect(p.root.style.colorScheme).toBe('light')
        const cached = vi.fn()
        p.iter.onState(cached)
        expect(cached).toHaveBeenCalledWith(state)
        unsubscribe()
        p.receive({ type: 'iter:state', state: { theme: { id: 'next', kind: 'dark', vars: { '--text': '#456' } } } })
        expect(p.variables.has('--old')).toBe(false)
        expect(received).toHaveBeenCalledTimes(1)
        expect(p.root.style.colorScheme).toBe('dark')
    })

    it('times out unanswered requests, handles cloning failures and ignores stale/invalid replies', async () => {
        const p = panel()
        const timed = expect(p.iter.getSource()).rejects.toMatchObject({ message: expect.stringContaining('超时') })
        p.receive({ type: 'iter:reply', id: p.requests[0].id, ok: 'yes' })
        await vi.advanceTimersByTimeAsync(35_000)
        await timed
        p.receive({ type: 'iter:reply', id: p.requests[0].id, ok: true, value: 'late' })
        expect(vi.getTimerCount()).toBe(0)
        p.parent.postMessage.mockImplementationOnce(() => {
            throw new Error('not cloneable')
        })
        await expect(p.iter.invoke('bad', () => {})).rejects.toMatchObject({ message: 'not cloneable' })
        expect(vi.getTimerCount()).toBe(0)
    })
})
