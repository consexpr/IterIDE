import { expect, it } from 'vitest'
import { outputDiff, showWhitespace } from './outputDiff'

const exact = { kind: 'builtin' as const, builtin: 'exact' as const }
it('aligns insertions and preserves the unchanged tail', () => {
    const diff = outputDiff('a\nextra\nb\nc', 'a\nb\nc', exact)
    expect(diff.rows.map((row) => row.kind)).toEqual(['same', 'extra', 'same', 'same'])
    expect(diff.differences).toEqual([1])
})
it('shows missing tails and completely missing output', () => {
    expect(outputDiff('a', 'a\nb', exact).rows.map((row) => row.kind)).toEqual(['same', 'missing'])
    expect(outputDiff('', 'a', exact).rows[0]).toMatchObject({ kind: 'missing', expected: { text: 'a' } })
})
it('matches the selected whitespace and value rules', () => {
    expect(outputDiff('1  2\n', '1\n2', { kind: 'builtin', builtin: 'tokens' }).differences).toEqual([])
    expect(outputDiff('a  \n\n', 'a\n', { kind: 'builtin', builtin: 'lines' }).differences).toEqual([])
    expect(outputDiff('a\n', 'a', exact).differences).toHaveLength(1)
    expect(
        outputDiff('1.0000001 YES', '1 yes', { kind: 'builtin', builtin: 'tokens', value: 'float6' }).differences
    ).toHaveLength(1)
    expect(outputDiff('YES No', 'yes NO', { kind: 'builtin', builtin: 'tokens', value: 'yesno' }).differences).toEqual(
        []
    )
    expect(outputDiff('x\r\ny', 'x\ny', exact).differences).toEqual([])
})
it('retains source positions for token alignment and labels custom comparisons as auxiliary', () => {
    const diff = outputDiff('first\n\twrong', 'first\nright', { kind: 'builtin', builtin: 'tokens' })
    expect(diff.rows[1]).toMatchObject({
        kind: 'changed',
        actual: { line: 2, column: 2 },
        expected: { line: 2, column: 1 }
    })
    expect(outputDiff('a', 'b', { kind: 'custom' }).authoritative).toBe(false)
    expect(showWhitespace(' \t\n')).toBe('·⇥↵\n')
})
it('bounds large mismatching output and reports simplified alignment', () => {
    const diff = outputDiff(Array(3000).fill('a').join('\n'), Array(3000).fill('b').join('\n'), exact)
    expect(diff.limited).toBe(true)
    expect(diff.simplified).toBe(true)
    expect(diff.rows).toHaveLength(2000)
})
