import { expect, it } from 'vitest'
import { LEGACY_BRAND } from '../../shared/legacyBrand'
import { storedValue } from './storage'

it('copies legacy preferences to the new key while preserving existing ITER choices', () => {
    const values = new Map([[`${LEGACY_BRAND}.watches`, '["answer"]']])
    const storage = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
            values.set(key, value)
        }
    }
    expect(storedValue('iter.watches', storage)).toBe('["answer"]')
    expect(values.get('iter.watches')).toBe('["answer"]')
    values.set('iter.watches', '["other"]')
    expect(storedValue('iter.watches', storage)).toBe('["other"]')
    expect(values.get(`${LEGACY_BRAND}.watches`)).toBe('["answer"]')
})
