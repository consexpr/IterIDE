import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import fixtures from './golden-fixtures.json'
import { featureArrays, fileStats, probabilities, type LexicalToken } from './features'
import { validModelRequest, validModelResult } from '../../shared/model'

describe('frozen Python/Clang preprocessing parity', () => {
    for (const fixture of fixtures)
        it(`matches every input byte for ${fixture.request.prefix}`, () => {
            const arrays = featureArrays(fixture.request, fixture.tokens)
            for (const [name, array] of Object.entries(arrays)) {
                const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength)
                expect(createHash('sha256').update(bytes).digest('hex')).toBe(
                    (fixture.feature_sha256 as Record<string, string>)[name]
                )
            }
            expect(validModelRequest(fixture.request)).toBe(true)
        })

    it('normalizes probabilities without changing stable order on ties', () => {
        expect(probabilities([1e10, 1e10, 1e10])).toEqual({ order: [0, 1, 2], probabilities: [1 / 3, 1 / 3, 1 / 3] })
        expect(validModelResult(probabilities([-20, 30, -400]), 3)).toBe(true)
        expect(validModelResult({ order: [0, 0], probabilities: [0.5, 0.5] }, 2)).toBe(false)
        expect(validModelRequest({ ...fixtures[0].request, cursor: -1 })).toBe(false)
        expect(validModelRequest({ ...fixtures[0].request, candidates: Array(101).fill({ label: 'x' }) })).toBe(false)
    })
})

/** Words separated by single spaces; kind 1 for a few keywords, 2 for names, 0 for punctuation. */
function lex(text: string): { source: Buffer; tokens: LexicalToken[] } {
    let start = 0
    const tokens = text.split(' ').map((word) => {
        const token = {
            kind: ['int', 'for', 'return'].includes(word) ? 1 : /^[A-Za-z]/.test(word) ? 2 : 0,
            start,
            end: start + word.length
        }
        start += word.length + 1
        return token
    })
    return { source: Buffer.from(text), tokens }
}

describe("file-wide statistics (same cases as the trainer's test_file_stats)", () => {
    it('counts occurrences, distance, declarations and ignores the word being typed', () => {
        const text = 'int dp [ 5 ] ; dp = dp + dam'
        const { source, tokens } = lex(text)
        const rows = fileStats(source, tokens, text.length, 'dam', ['dp', 'dam', 'missing'])
        const row = (i: number) => Array.from(rows.slice(i * 8, i * 8 + 8))
        expect(row(0)[0]).toBeCloseTo(Math.log1p(3) / 5, 6)
        expect(row(0)[1]).toBeCloseTo(Math.log1p(3) / 5, 6)
        expect(row(0)[2]).toBeCloseTo(1 / 3, 6)
        expect(row(0).slice(3, 5)).toEqual([0, 0])
        expect(row(0)[5]).toBe(1)
        expect(row(1).slice(0, 6)).toEqual([0, 0, 0, 0, 0, 0])
        expect(row(2)).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    })

    it('flags occurrences outside the 128-token window and measures distance to the right', () => {
        const far = Array(200).fill('x').join(' ')
        const text = `total ${far}`
        const { source, tokens } = lex(`${text} total`)
        expect(fileStats(source, tokens, Buffer.byteLength(text), '', ['total'])[4]).toBe(1)
        const near = lex('a b c total')
        expect(fileStats(near.source, near.tokens, 3, '', ['total'])[3]).toBeCloseTo(0.5, 6)
        const adjacent = lex('a b total')
        expect(fileStats(adjacent.source, adjacent.tokens, 3, '', ['total'])[3]).toBe(1)
    })
})
