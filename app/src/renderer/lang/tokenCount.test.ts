import { describe, expect, it } from 'vitest'
import { countTokens } from './tokenCount'
import {
    getModelStats,
    recordModelCall,
    recordModelFailure,
    recordModelReuse,
    resetModelStats,
    subscribeModelStats
} from './modelStats'

describe('countTokens', () => {
    it('counts identifiers, numbers and punctuators, ignoring whitespace', () => {
        expect(countTokens('')).toBe(0)
        expect(countTokens('int x = 100;')).toBe(5)
        expect(countTokens('a<<=b->c::d++')).toBe(8)
        expect(countTokens("1'000'000 3.14e-2 0x1fULL")).toBe(3)
    })

    it('skips comments but not what follows them', () => {
        expect(countTokens('a // b c\nd')).toBe(2)
        expect(countTokens('a /* b\nc */ d')).toBe(2)
        expect(countTokens('a // continued \\\n still comment\nb')).toBe(2)
        expect(countTokens('a /* never closed')).toBe(1)
    })

    it('counts each string, character and raw string literal as one token', () => {
        expect(countTokens('s = "a b" + u8"c" + L\'x\';')).toBe(8)
        expect(countTokens('R"x(raw ) " text)x" + y')).toBe(3)
        expect(countTokens('"escaped \\" quote" z')).toBe(2)
    })

    it('counts a whole include line', () => {
        expect(countTokens('#include <bits/stdc++.h>\nusing namespace std;')).toBeGreaterThan(8)
    })
})

describe('model stats', () => {
    it('accumulates calls, reuse and failures and notifies subscribers', () => {
        resetModelStats()
        let notified = 0
        const stop = subscribeModelStats(() => notified++)
        recordModelCall(10)
        recordModelCall(30)
        recordModelReuse()
        recordModelFailure()
        expect(getModelStats()).toEqual({ calls: 2, reused: 1, failed: 1, lastMs: 30, totalMs: 40 })
        expect(notified).toBe(4)
        stop()
        recordModelCall(1)
        expect(notified).toBe(4)
        resetModelStats()
    })
})
