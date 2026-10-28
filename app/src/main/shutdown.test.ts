import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ShutdownCoordinator } from './shutdown'
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
function fixture() {
    const actions = { request: vi.fn(), dispose: vi.fn(async () => {}), close: vi.fn(), notify: vi.fn() }
    return { actions, coordinator: new ShutdownCoordinator(actions, 1000, 500) }
}
it('requires the matching renderer acknowledgment and awaits cleanup exactly once', async () => {
    const { actions, coordinator } = fixture()
    let finish!: () => void
    actions.dispose.mockImplementationOnce(
        () =>
            new Promise<void>((resolve) => {
                finish = resolve
            })
    )
    coordinator.request()
    coordinator.request()
    expect(actions.request).toHaveBeenCalledTimes(1)
    const { requestId } = actions.request.mock.calls[0][0]
    await expect(coordinator.resolve('stale', 'ready')).rejects.toThrow('过期')
    expect(actions.dispose).not.toHaveBeenCalled()
    const pending = coordinator.resolve(requestId, 'ready')
    expect(coordinator.canClose).toBe(false)
    await expect(coordinator.resolve(requestId, 'ready')).rejects.toThrow('过期')
    expect(actions.dispose).toHaveBeenCalledTimes(1)
    finish()
    await pending
    expect(coordinator.canClose).toBe(true)
    expect(actions.close).not.toHaveBeenCalled()
    await vi.runAllTimersAsync()
    expect(actions.close).toHaveBeenCalledTimes(1)
})
it('keeps the window open on cancellation or a missing renderer response', async () => {
    const { actions, coordinator } = fixture()
    coordinator.request()
    await coordinator.resolve(actions.request.mock.calls[0][0].requestId, 'cancel')
    expect(actions.dispose).not.toHaveBeenCalled()
    coordinator.request()
    await vi.advanceTimersByTimeAsync(1000)
    expect(coordinator.canClose).toBe(false)
    expect(actions.notify).toHaveBeenCalledWith(expect.stringContaining('窗口已保留'))
    expect(actions.close).not.toHaveBeenCalled()
})
it('never destroys the sender when service cleanup fails or times out', async () => {
    const { actions, coordinator } = fixture()
    actions.dispose.mockRejectedValueOnce(new Error('cleanup failed'))
    coordinator.request()
    await expect(coordinator.resolve(actions.request.mock.calls[0][0].requestId, 'ready')).rejects.toThrow(
        'cleanup failed'
    )
    expect(coordinator.canClose).toBe(false)
    expect(actions.close).not.toHaveBeenCalled()
    actions.dispose.mockImplementationOnce(() => new Promise<void>(() => {}))
    coordinator.request()
    const pending = expect(coordinator.resolve(actions.request.mock.calls[1][0].requestId, 'ready')).rejects.toThrow(
        '超时'
    )
    await vi.advanceTimersByTimeAsync(500)
    await pending
    expect(coordinator.canClose).toBe(false)
    expect(actions.close).not.toHaveBeenCalled()
})

it('recovers from a dead renderer without waiting for its pending close acknowledgment', async () => {
    const { actions, coordinator } = fixture()
    coordinator.request()
    await coordinator.recover('restart')
    await vi.runAllTimersAsync()
    expect(actions.dispose).toHaveBeenCalledTimes(1)
    expect(actions.close).toHaveBeenCalledExactlyOnceWith(true)
    expect(actions.notify).not.toHaveBeenCalled()
    expect(coordinator.canClose).toBe(true)
})

it('keeps a bounded exit path when cleanup is stuck and coalesces recovery clicks', async () => {
    const { actions, coordinator } = fixture()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    actions.dispose.mockImplementation(() => new Promise<void>(() => {}))
    const pending = coordinator.recover('exit')
    expect(coordinator.recover('restart')).toBe(pending)
    await vi.advanceTimersByTimeAsync(500)
    await pending
    await vi.runAllTimersAsync()
    expect(actions.close).toHaveBeenCalledExactlyOnceWith(false)
    expect(actions.dispose).toHaveBeenCalledTimes(1)
    log.mockRestore()
})

it('does not schedule two closes when the renderer fails during normal cleanup', async () => {
    const { actions, coordinator } = fixture()
    let finish!: () => void
    const cleanup = new Promise<void>((resolve) => {
        finish = resolve
    })
    actions.dispose.mockReturnValue(cleanup)
    coordinator.request()
    const normal = coordinator.resolve(actions.request.mock.calls[0][0].requestId, 'ready')
    const recovery = coordinator.recover('restart')
    finish()
    await Promise.all([normal, recovery])
    await vi.runAllTimersAsync()
    expect(actions.close).toHaveBeenCalledExactlyOnceWith(true)
})
