import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
    state: { ready: true, closing: false },
    flushFiles: vi.fn(async () => {}),
    flushProblems: vi.fn(async () => {}),
    pause: vi.fn(),
    save: vi.fn(async () => {})
}))
vi.mock('../state/app', () => ({
    store: {
        get: () => fixture.state,
        set: (patch: Partial<typeof fixture.state>) => Object.assign(fixture.state, patch)
    }
}))
vi.mock('./files', () => ({ flushFileOperations: fixture.flushFiles }))
vi.mock('./problemWrites', () => ({ flushProblemWrites: fixture.flushProblems }))
vi.mock('./session', () => ({ pauseSessionSaving: fixture.pause, saveSessionNow: fixture.save }))
beforeEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
    vi.useFakeTimers()
    fixture.state = { ready: true, closing: false }
    vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
})

it('waits for accepted file operations before preserving live buffers exactly once', async () => {
    let finish!: () => void
    fixture.flushFiles.mockImplementationOnce(
        () =>
            new Promise<void>((resolve) => {
                finish = resolve
            })
    )
    const { preserveRecoverySession } = await import('./recovery')
    const pending = preserveRecoverySession()
    expect(preserveRecoverySession()).toBe(pending)
    expect(fixture.state.closing).toBe(true)
    expect(fixture.save).not.toHaveBeenCalled()
    finish()
    expect(await pending).toContain('当前编辑内容已保存')
    expect(fixture.save).toHaveBeenCalledTimes(1)
    expect(fixture.pause).toHaveBeenCalledTimes(1)
})

it('preserves the previous session if boot failed before restoration finished', async () => {
    fixture.state.ready = false
    const { preserveRecoverySession } = await import('./recovery')
    expect(await preserveRecoverySession()).toContain('保留上次会话')
    expect(fixture.save).not.toHaveBeenCalled()
})

it('reports failed persistence and bounds stalled operations without writing a late snapshot', async () => {
    let finish!: () => void
    fixture.flushFiles.mockImplementationOnce(
        () =>
            new Promise<void>((resolve) => {
                finish = resolve
            })
    )
    const { preserveRecoverySession } = await import('./recovery')
    const pending = preserveRecoverySession()
    await vi.advanceTimersByTimeAsync(4000)
    expect(await pending).toContain('未能保存')
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.save).not.toHaveBeenCalled()
})

it('never reports a successful snapshot after a disk error', async () => {
    fixture.save.mockRejectedValueOnce(new Error('disk full'))
    const { preserveRecoverySession } = await import('./recovery')
    expect(await preserveRecoverySession()).toContain('未能保存')
})
