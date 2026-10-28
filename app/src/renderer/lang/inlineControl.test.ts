import { expect, it } from 'vitest'
import { activateInlineShortcut, allowInlineRequest } from './inlineControl'
it('consumes each manual trigger once without enabling subsequent requests', () => {
    expect(allowInlineRequest()).toBe(false)
    activateInlineShortcut()
    expect(allowInlineRequest()).toBe(true)
    expect(allowInlineRequest()).toBe(false)
    activateInlineShortcut()
    expect(allowInlineRequest()).toBe(true)
    expect(allowInlineRequest()).toBe(false)
})
