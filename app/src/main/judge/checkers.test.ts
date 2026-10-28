import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { builtinCheck, checkerArgs, checkerVerdict } from './checkers'
import { parseDiagnostics } from './diagnostics'
import { splitArgs } from '../toolchain/args'

describe('streamed built-in checkers', () => {
    let dir: string
    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-checker-test-'))
    })
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true })
    })
    it.each([
        ['tokens', ' 1\n 2 ', '1 2', 'AC'],
        ['tokens', '1\n4', '1\n5', 'WA'],
        ['lines', 'a  \r\nb\t\r\n\r\n', 'a\nb\n', 'AC'],
        ['lines', 'a\n\nb', 'a\nb', 'WA'],
        ['exact', 'a\r\nb', 'a\nb', 'AC'],
        ['exact', 'a ', 'a', 'WA'],
        ['float4', '1.00009 yes', '1 yes', 'AC'],
        ['float6', '1.00009', '1', 'WA'],
        ['float9', '1000000000.5', '1000000000', 'AC'],
        ['float6', 'nan', '0', 'WA'],
        ['yesno', 'YeS no', 'YES NO', 'AC']
    ] as const)('%s compares %j against %j', async (kind, output, answer, verdict) => {
        const out = path.join(dir, 'out'),
            ans = path.join(dir, 'ans')
        await fs.writeFile(out, output)
        await fs.writeFile(ans, answer)
        expect((await builtinCheck(out, ans, kind)).verdict).toBe(verdict)
    })
    it('compares beyond stream chunk boundaries', async () => {
        const out = path.join(dir, 'out'),
            ans = path.join(dir, 'ans')
        await fs.writeFile(out, '1 '.repeat(20_000) + '4')
        await fs.writeFile(ans, '1\n'.repeat(20_000) + '5')
        expect(await builtinCheck(out, ans)).toMatchObject({
            verdict: 'WA',
            checkerMessage: 'line 20001, token 1: expected "5", found "4"'
        })
        await fs.writeFile(out, 'a'.repeat(16_383) + '\r\nend')
        await fs.writeFile(ans, 'a'.repeat(16_383) + '\nend')
        expect((await builtinCheck(out, ans, 'exact')).verdict).toBe('AC')
    })
    it('maps checker codes and safely expands quoted arguments', () => {
        expect([0, 1, 2, 3, 7].map((c) => checkerVerdict(c, '').verdict)).toEqual(['AC', 'WA', 'PE', 'SE', 'AC'])
        expect(
            checkerArgs('"{input}" {output} {answer}', {
                input: 'a b.in',
                output: 'x y.out',
                answer: 'z.ans',
                score: ''
            })
        ).toEqual(['a b.in', 'x y.out', 'z.ans'])
        expect(splitArgs('-I "D:\\some path\\include" -DVALUE=1')).toEqual([
            '-I',
            'D:\\some path\\include',
            '-DVALUE=1'
        ])
        expect(
            parseDiagnostics('tmp.cpp:1:2: error: broken\ntmp.cpp:2:1: note: detail', 'tmp.cpp', 'user.cpp')[0].message
        ).toBe('broken\nnote: detail')
    })
})
