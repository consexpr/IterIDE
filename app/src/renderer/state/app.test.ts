import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ save: vi.fn() }))
vi.mock('../util/storage', () => ({ load: (_key: string, fallback: unknown) => fallback, save: fixture.save }))
beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
})
afterEach(() => vi.unstubAllGlobals())

describe('watch persistence', () => {
    it('writes only when watches change, independently of cursor and debug traffic', async () => {
        const { store } = await import('./app')
        const { setCursor, cursorStore } = await import('./cursor')
        const appListener = vi.fn(),
            cursorListener = vi.fn()
        const off = store.subscribe(appListener),
            offCursor = cursorStore.subscribe(cursorListener)
        for (let col = 1; col <= 1000; col++) setCursor(1, col)
        expect(appListener).not.toHaveBeenCalled()
        expect(cursorStore.get()).toEqual({ line: 1, col: 1000 })
        expect(cursorListener).toHaveBeenCalledTimes(999)
        setCursor(1, 1000)
        expect(cursorListener).toHaveBeenCalledTimes(999)
        expect(fixture.save).not.toHaveBeenCalled()
        store.set({ watches: ['answer'] })
        setCursor(2, 1)
        expect(fixture.save).toHaveBeenCalledExactlyOnceWith('iter.watches', ['answer'])
        off()
        offCursor()
    })
})
