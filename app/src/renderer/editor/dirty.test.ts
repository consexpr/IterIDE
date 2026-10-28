import { expect, it, vi } from 'vitest'
import { isModelDirty } from './dirty'

it('does not read full text for normal typing or undo back to the saved version', () => {
    let text = 'saved',
        version = 1
    const model = {
        getAlternativeVersionId: () => version,
        getValueLength: () => text.length,
        getValue: vi.fn(() => text)
    }
    for (let i = 0; i < 1000; i++) {
        text += 'x'
        version++
        expect(isModelDirty(model, 1, 'saved')).toBe(true)
    }
    version = 1
    text = 'saved'
    expect(isModelDirty(model, 1, 'saved')).toBe(false)
    expect(model.getValue).not.toHaveBeenCalled()
})

it('distinguishes same-length replacements and manually recreated saved content', () => {
    let text = 'other'
    const model = { getAlternativeVersionId: () => 2, getValueLength: () => text.length, getValue: () => text }
    expect(isModelDirty(model, 1, 'saved')).toBe(true)
    text = 'saved'
    expect(isModelDirty(model, 1, 'saved')).toBe(false)
})
