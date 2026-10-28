import { afterEach, beforeEach, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveBuiltin } from '../../shared/problem'
import { builtinCheck } from './checkers'

let dir: string
beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-checker-'))
})
afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
})

async function check(
    output: string,
    answer: string,
    layout: Parameters<typeof builtinCheck>[2],
    value?: Parameters<typeof builtinCheck>[4]
) {
    const a = path.join(dir, 'out'),
        b = path.join(dir, 'ans')
    await fs.writeFile(a, output)
    await fs.writeFile(b, answer)
    return (await builtinCheck(a, b, layout, undefined, value)).verdict
}

it('splits stored comparators into layout and value, reading the older combined ids', () => {
    expect(resolveBuiltin(undefined)).toEqual({ layout: 'tokens', value: 'text' })
    expect(resolveBuiltin('lines', 'float6')).toEqual({ layout: 'lines', value: 'float6' })
    expect(resolveBuiltin('float9')).toEqual({ layout: 'tokens', value: 'float9' })
    expect(resolveBuiltin('exact', 'bogus' as never)).toEqual({ layout: 'exact', value: 'text' })
})

it('combines token layout with a value rule', async () => {
    expect(await check('1.0000004   2', '1.0\n2', 'tokens', 'float6')).toBe('AC')
    expect(await check('1.001 2', '1.0 2', 'tokens', 'float6')).toBe('WA')
    expect(await check('yes', 'YES', 'tokens', 'yesno')).toBe('AC')
    expect(await check('yes', 'YES', 'tokens', 'text')).toBe('WA')
})

it('combines line layout with a value rule: spacing inside a line still has to match', async () => {
    expect(await check('1.0000004 2  \n\n', '1.0 2\n', 'lines', 'float6')).toBe('AC')
    expect(await check('1.0 2\n', '1.0  2\n', 'lines', 'float6')).toBe('WA')
    expect(await check('1.001 2\n', '1.0 2\n', 'lines', 'float6')).toBe('WA')
})

it('combines exact layout with a value rule: trailing newline and spacing must match', async () => {
    expect(await check('1.0000004 2\n', '1.0 2\n', 'exact', 'float6')).toBe('AC')
    expect(await check('1.0 2', '1.0 2\n', 'exact', 'float6')).toBe('WA')
    expect(await check('1.0 2 \n', '1.0 2\n', 'exact', 'float6')).toBe('WA')
    expect(await check('a\r\nb\r\n', 'a\nb\n', 'exact', 'yesno')).toBe('AC')
})

it('keeps the older combined ids working', async () => {
    expect(await check('1.0000004', '1.0', 'float6')).toBe('AC')
    expect(await check('YES', 'yes', 'yesno')).toBe('AC')
})
