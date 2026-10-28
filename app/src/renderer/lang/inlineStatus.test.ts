import { expect, it, vi } from 'vitest'
import { beginInlineRequest, getInlinePending, subscribeInlineStatus } from './inlineStatus'
it('keeps overlapping requests active and finishes each request only once', () => {
    const changed = vi.fn()
    const off = subscribeInlineStatus(changed)
    const first = beginInlineRequest()
    const second = beginInlineRequest()
    expect(getInlinePending()).toBe(true)
    first()
    first()
    expect(getInlinePending()).toBe(true)
    second()
    expect(getInlinePending()).toBe(false)
    expect(changed).toHaveBeenCalledTimes(4)
    off()
})
