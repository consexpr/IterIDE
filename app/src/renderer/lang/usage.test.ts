import { describe, expect, it } from 'vitest'
import { CompletionUsageStore } from './usage'

describe('accepted completion usage', () => {
    it('persists counts and round trips bundles without double counting imports', () => {
        let serialized: string | null = null
        const storage = {
            getItem: () => serialized,
            setItem: (_key: string, value: string) => {
                serialized = value
            }
        }
        const store = new CompletionUsageStore(storage)
        store.record('variable:vec')
        store.record('variable:vec')
        expect(new CompletionUsageStore(storage).frequency('variable:vec')).toBe(2)
        const bundle = store.exportUsage()
        store.importUsage(bundle)
        store.importUsage({ 'variable:total': 4 })
        expect(store.exportUsage()).toEqual({ 'variable:vec': 2, 'variable:total': 4 })
        bundle['variable:vec'] = 200
        expect(store.frequency('variable:vec')).toBe(2)
    })
    it('tolerates unavailable/quota storage, corrupted data and invalid imports', () => {
        const store = new CompletionUsageStore({
            getItem: () => '{',
            setItem: () => {
                throw new Error('quota')
            }
        })
        expect(() => store.record('function:sort')).not.toThrow()
        store.importUsage({ valid: 3, negative: -1, float: 1.5, huge: Infinity, text: '4' })
        store.importUsage(null)
        store.importUsage([])
        expect(store.exportUsage()).toEqual({ 'function:sort': 1, valid: 3 })
    })
})
