import { equalLine, equalToken } from '../../shared/checkerComparison'
import { resolveBuiltin, type CheckerLayout, type CheckerRef } from '../../shared/problem'

export interface DiffUnit {
    text: string
    line: number
    column: number
}
export interface DiffRow {
    actual?: DiffUnit
    expected?: DiffUnit
    kind: 'same' | 'changed' | 'missing' | 'extra'
}
const MAX_CHARS = 100_000,
    MAX_UNITS = 2000,
    MAX_CELLS = 250_000

function units(source: string, layout: CheckerLayout): { units: DiffUnit[]; limited: boolean } {
    let limited = source.length > MAX_CHARS
    const text = source.slice(0, MAX_CHARS)
    const result: DiffUnit[] = []
    if (layout === 'tokens') {
        let line = 1,
            column = 1
        for (const match of text.matchAll(/\s+|\S+/g)) {
            const part = match[0]
            if (/^\S/.test(part)) result.push({ text: part, line, column })
            const lastNewline = part.lastIndexOf('\n')
            if (lastNewline >= 0) {
                line += part.split('\n').length - 1
                column = part.length - lastNewline
            } else column += part.length
            if (result.length > MAX_UNITS) {
                limited = true
                break
            }
        }
    } else {
        const lines = text
            ? (layout === 'exact' ? text.replace(/\r\n?/g, '\n') : text.replace(/\r\n/g, '\n')).split('\n')
            : []
        if (layout === 'lines') {
            for (let i = 0; i < lines.length; i++) lines[i] = lines[i].replace(/[\t \r]+$/, '')
            while (lines.at(-1) === '') lines.pop()
        }
        limited ||= lines.length > MAX_UNITS
        for (let i = 0; i < Math.min(lines.length, MAX_UNITS); i++)
            result.push({ text: lines[i], line: i + 1, column: 1 })
    }
    return { units: result.slice(0, MAX_UNITS), limited }
}

/** Bounded alignment: common edges, then LCS for small middles or local resynchronization for large ones. */
export function outputDiff(actual: string, expected: string, checker?: CheckerRef) {
    const authoritative = checker?.kind === 'builtin'
    const rule = authoritative
        ? resolveBuiltin(checker.builtin, checker.value)
        : { layout: 'exact' as const, value: 'text' as const }
    const a = units(actual, rule.layout),
        b = units(expected, rule.layout)
    const same = (i: number, j: number): boolean =>
        (rule.layout === 'tokens' ? equalToken : equalLine)(a.units[i].text, b.units[j].text, rule.value)
    const rows: DiffRow[] = []
    let i = 0,
        j = 0,
        ae = a.units.length,
        be = b.units.length
    while (i < ae && j < be && same(i, j)) rows.push({ kind: 'same', actual: a.units[i++], expected: b.units[j++] })
    let suffix = 0
    while (i < ae && j < be && same(ae - 1, be - 1)) {
        ae--
        be--
        suffix++
    }
    const width = be - j + 1,
        cells = (ae - i + 1) * width
    const simplified = cells > MAX_CELLS
    let table: Uint16Array | undefined
    const ai = i,
        bj = j
    if (!simplified && i < ae && j < be) {
        table = new Uint16Array(cells)
        for (let x = ae - 1; x >= i; x--)
            for (let y = be - 1; y >= j; y--) {
                const cell = (x - ai) * width + y - bj
                table[cell] = same(x, y) ? 1 + table[cell + width + 1] : Math.max(table[cell + width], table[cell + 1])
            }
    }
    while (i < ae || j < be) {
        if (i < ae && j < be && same(i, j)) {
            rows.push({ kind: 'same', actual: a.units[i++], expected: b.units[j++] })
            continue
        }
        let extra = j >= be
        if (i < ae && j < be) {
            if (table) {
                const cell = (i - ai) * width + j - bj
                extra = table[cell + width] >= table[cell + 1]
            } else {
                let skipA = Infinity,
                    skipB = Infinity
                for (let n = 1; n <= 32; n++) {
                    if (skipA === Infinity && i + n < ae && same(i + n, j)) skipA = n
                    if (skipB === Infinity && j + n < be && same(i, j + n)) skipB = n
                }
                if (skipA === Infinity && skipB === Infinity) {
                    rows.push({ kind: 'changed', actual: a.units[i++], expected: b.units[j++] })
                    continue
                }
                extra = skipA <= skipB
            }
        }
        if (i < ae && extra) rows.push({ kind: 'extra', actual: a.units[i++] })
        else rows.push({ kind: 'missing', expected: b.units[j++] })
    }
    for (let n = 0; n < suffix; n++) rows.push({ kind: 'same', actual: a.units[ae + n], expected: b.units[be + n] })
    const compact: DiffRow[] = []
    for (let cursor = 0; cursor < rows.length; ) {
        if (rows[cursor].kind === 'same' || rows[cursor].kind === 'changed') {
            compact.push(rows[cursor++])
            continue
        }
        const actuals: DiffUnit[] = [],
            expecteds: DiffUnit[] = []
        while (cursor < rows.length && ['extra', 'missing'].includes(rows[cursor].kind)) {
            const row = rows[cursor++]
            if (row.actual) actuals.push(row.actual)
            if (row.expected) expecteds.push(row.expected)
        }
        for (let n = 0; n < Math.max(actuals.length, expecteds.length); n++)
            compact.push({
                actual: actuals[n],
                expected: expecteds[n],
                kind: actuals[n] && expecteds[n] ? 'changed' : actuals[n] ? 'extra' : 'missing'
            })
    }
    return {
        rows: compact,
        differences: compact.flatMap((row, index) => (row.kind === 'same' ? [] : [index])),
        limited: a.limited || b.limited,
        simplified,
        authoritative,
        rule
    }
}

export { showWhitespace } from './whitespace'
