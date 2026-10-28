import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ ready: false, open: vi.fn(async (_path: string) => {}) }))
vi.mock('./files', () => ({ openFile: fixture.open }))
vi.mock('../state/app', () => ({
    store: {
        get: () => ({ ready: fixture.ready }),
        set: ({ ready }: { ready: boolean }) => {
            fixture.ready = ready
        }
    }
}))
beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    fixture.ready = false
})

describe('startup file opens', () => {
    it('queues argv and second-instance files until session restoration is finished', async () => {
        const { openExternalFiles, finishStartup } = await import('./startup')
        openExternalFiles(['/restoring.cpp'])
        openExternalFiles(['/second-instance.cpp'])
        expect(fixture.open).not.toHaveBeenCalled()
        await finishStartup()
        expect(fixture.ready).toBe(true)
        expect(fixture.open.mock.calls.map(([path]) => path)).toEqual(['/restoring.cpp', '/second-instance.cpp'])
        openExternalFiles(['/ready.cpp'])
        expect(fixture.open).toHaveBeenLastCalledWith('/ready.cpp')
    })
})
