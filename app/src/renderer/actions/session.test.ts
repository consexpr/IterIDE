import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
    text: 'first',
    version: 1,
    read: vi.fn(),
    save: vi.fn(async (_snapshot: any) => {}),
    view: null as any
}))
const model = {
    getValue: () => {
        fixture.read()
        return fixture.text
    },
    getAlternativeVersionId: () => fixture.version
}
vi.mock('../editor/instance', () => ({ editorRef: { editor: null } }))
vi.mock('../state/app', () => ({
    store: {
        get: () => ({
            activePath: '/sample.cpp',
            files: [{ path: '/sample.cpp', savedText: 'base', model, viewState: fixture.view }]
        })
    },
    toast: vi.fn()
}))
vi.mock('./files', () => ({ activate: vi.fn(), checkAllExternal: vi.fn(), restoreTab: vi.fn() }))

beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.useFakeTimers()
    fixture.text = 'first'
    fixture.version = 1
    fixture.view = null
    vi.stubGlobal('window', {
        iter: { session: { save: fixture.save } },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
    })
})
afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

describe('session save coordination', () => {
    it('serializes snapshots so an older write cannot finish after the final save', async () => {
        const { saveSessionNow } = await import('./session')
        let finish!: () => void
        fixture.save.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve
                })
        )
        const first = saveSessionNow()
        await vi.advanceTimersByTimeAsync(0)
        fixture.text = 'final edit'
        fixture.version++
        const final = saveSessionNow()
        await vi.advanceTimersByTimeAsync(0)
        expect(fixture.save).toHaveBeenCalledTimes(1)
        finish()
        await Promise.all([first, final])
        expect(fixture.save.mock.calls.map(([snapshot]) => snapshot.tabs[0].text)).toEqual(['first', 'final edit'])
    })

    it('keeps accepting a final snapshot after a periodic write fails', async () => {
        const { saveSessionNow } = await import('./session')
        fixture.save.mockRejectedValueOnce(new Error('disk unavailable'))
        await expect(saveSessionNow()).rejects.toThrow('disk unavailable')
        fixture.text = 'retry'
        fixture.version++
        await saveSessionNow()
        expect(fixture.save).toHaveBeenLastCalledWith(
            expect.objectContaining({ tabs: [expect.objectContaining({ text: 'retry' })] })
        )
    })

    it('pauses periodic snapshots during close and restarts them only when close is cancelled', async () => {
        const { startSession, pauseSessionSaving, resumeSessionSaving } = await import('./session')
        const stop = startSession()
        pauseSessionSaving()
        await vi.advanceTimersByTimeAsync(30_000)
        expect(fixture.save).not.toHaveBeenCalled()
        resumeSessionSaving()
        await vi.advanceTimersByTimeAsync(10_000)
        expect(fixture.save).toHaveBeenCalledTimes(1)
        stop()
        fixture.text = 'after disposal'
        await vi.advanceTimersByTimeAsync(20_000)
        expect(fixture.save).toHaveBeenCalledTimes(1)
    })
})

it('skips unchanged buffers and IPC writes while still saving changed editor positions', async () => {
    const { saveSessionNow } = await import('./session')
    await saveSessionNow()
    for (let i = 0; i < 10; i++) await saveSessionNow()
    expect(fixture.read).toHaveBeenCalledTimes(1)
    expect(fixture.save).toHaveBeenCalledTimes(1)
    fixture.view = {
        cursorState: [
            {
                inSelectionMode: false,
                selectionStart: { lineNumber: 7, column: 2 },
                position: { lineNumber: 7, column: 2 }
            }
        ],
        viewState: { firstPosition: { lineNumber: 4, column: 1 }, firstPositionDeltaTop: 3, scrollLeft: 0 },
        contributionsState: { 'editor.contrib.folding': { collapsedRegions: [{ start: 2, end: 5 }] } }
    }
    await saveSessionNow()
    expect(fixture.read).toHaveBeenCalledTimes(1)
    expect(fixture.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ tabs: [expect.objectContaining({ viewState: fixture.view })] })
    )
    const { sessionHealth } = await import('../state/sessionHealth')
    fixture.text = 'changed'
    fixture.version++
    fixture.save.mockRejectedValueOnce(new Error('disk full'))
    await expect(saveSessionNow()).rejects.toThrow('disk full')
    expect(sessionHealth.get().error).toBe('disk full')
    await saveSessionNow()
    expect(sessionHealth.get().error).toBeNull()
})
