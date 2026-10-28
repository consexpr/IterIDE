import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
    state: {} as any,
    read: vi.fn(async (_path: string, _id: string): Promise<any> => ({}))
}))
vi.mock('../state/app', () => ({
    store: { get: () => fixture.state },
    updateFile: (path: string, patch: any) => {
        fixture.state.files = fixture.state.files.map((file: any) =>
            file.path === path ? { ...file, ...patch } : file
        )
    }
}))
beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    fixture.state = {
        files: [
            {
                path: '/sample.cpp',
                model: {},
                tests: [{ id: '1', name: 'one', input: '', answer: '', previewLoaded: false }]
            }
        ]
    }
    vi.stubGlobal('window', { iter: { problem: { readTest: fixture.read } } })
})
afterEach(() => vi.unstubAllGlobals())

describe('on-demand test previews', () => {
    it('requests the replacement metadata row without sharing the stale row request', async () => {
        const { loadTestPreview } = await import('./testPreviews')
        let finishOld!: (value: any) => void, finishNew!: (value: any) => void
        fixture.read
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        finishOld = resolve
                    })
            )
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        finishNew = resolve
                    })
            )
        const old = loadTestPreview('/sample.cpp', '1')
        fixture.state.files[0].tests = [{ ...fixture.state.files[0].tests[0], name: 'replacement metadata' }]
        const current = loadTestPreview('/sample.cpp', '1')
        expect(current).not.toBe(old)
        finishOld({ id: '1', input: 'stale' })
        await old
        finishNew({ id: '1', input: 'fresh' })
        await current
        expect(fixture.read).toHaveBeenCalledTimes(2)
        expect(fixture.state.files[0].tests[0]).toMatchObject({ input: 'fresh', previewLoaded: true })
    })
    it('deduplicates simultaneous expansions and marks the requested content loaded', async () => {
        const { loadTestPreview } = await import('./testPreviews')
        let finish!: (value: any) => void
        fixture.read.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve
                })
        )
        const first = loadTestPreview('/sample.cpp', '1')
        const second = loadTestPreview('/sample.cpp', '1')
        expect(first).toBe(second)
        finish({ id: '1', input: 'actual input', answer: 'actual answer' })
        await first
        expect(fixture.state.files[0].tests[0]).toMatchObject({
            input: 'actual input',
            answer: 'actual answer',
            previewLoaded: true
        })
        await loadTestPreview('/sample.cpp', '1')
        expect(fixture.read).toHaveBeenCalledTimes(1)
    })

    it('discards a late preview after the owning model or metadata row was replaced', async () => {
        const { loadTestPreview } = await import('./testPreviews')
        let finish!: (value: any) => void
        fixture.read.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve
                })
        )
        const first = loadTestPreview('/sample.cpp', '1')
        fixture.state.files[0] = {
            ...fixture.state.files[0],
            model: {},
            tests: [{ id: '1', input: 'new owner', previewLoaded: true }]
        }
        finish({ id: '1', input: 'old request', answer: '' })
        await first
        expect(fixture.state.files[0].tests[0].input).toBe('new owner')
    })

    it('does not load content before a preview is requested and permits retry after a failure', async () => {
        const { loadTestPreview } = await import('./testPreviews')
        expect(fixture.read).not.toHaveBeenCalled()
        fixture.read.mockRejectedValueOnce(new Error('read failed'))
        await expect(loadTestPreview('/sample.cpp', '1')).rejects.toThrow('read failed')
        fixture.read.mockResolvedValueOnce({ id: '1', input: 'retry content', answer: '' })
        await loadTestPreview('/sample.cpp', '1')
        expect(fixture.state.files[0].tests[0].input).toBe('retry content')
    })
})
