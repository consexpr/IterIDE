import { afterEach, beforeEach, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { customCheck, prepareTool } from './checkers'
import { N_CHECK_TEMPLATE } from '../../shared/nCheck'
import type { ToolchainSettings } from '../../shared/judge'

const tools = {
    compiler: 'g++',
    flags: '-std=c++17',
    debugFlags: '-g',
    outputLimitBytes: 1 << 20,
    displayLimitChars: 10_000
} as ToolchainSettings
let dir: string
beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-n-check-'))
})
afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
})

it('compiles the template without including testlib and judges by exit code and stderr', async () => {
    await fs.writeFile(path.join(dir, 'checker.cpp'), N_CHECK_TEMPLATE)
    const exe = await prepareTool(dir, 'checker.cpp', tools)
    const run = async (output: string, answer: string) => {
        const files = {
            input: path.join(dir, 'in'),
            output: path.join(dir, 'out'),
            answer: path.join(dir, 'ans'),
            score: ''
        }
        await fs.writeFile(files.input, '')
        await fs.writeFile(files.output, output)
        await fs.writeFile(files.answer, answer)
        return customCheck(exe, { kind: 'custom' }, files, tools, new AbortController().signal)
    }
    expect((await run('42\n', '42\n')).verdict).toBe('AC')
    expect(await run('41\n', '42\n')).toMatchObject({ verdict: 'WA', checkerMessage: 'expected 42, found 41' })
    expect(await run('x\n', '42\n')).toMatchObject({ verdict: 'PE' })
}, 60_000)

it('automatically provides testlib for a checker pasted under the legacy n-check filename', async () => {
    const name = 'checker-n-check.cpp'
    await fs.writeFile(
        path.join(dir, name),
        '#define CHECKER_LIBRARY "testlib.h"\n#include CHECKER_LIBRARY\nint main(int argc,char**argv){registerTestlibCmd(argc,argv);if(ouf.readInt()!=ans.readInt())quitf(_wa,"different");quitf(_ok,"correct");}'
    )
    const exe = await prepareTool(dir, name, tools)
    const files = {
        input: path.join(dir, 'input'),
        output: path.join(dir, 'output'),
        answer: path.join(dir, 'answer'),
        score: ''
    }
    await Promise.all([
        fs.writeFile(files.input, ''),
        fs.writeFile(files.output, '42\n'),
        fs.writeFile(files.answer, '42\n')
    ])
    expect((await customCheck(exe, { kind: 'custom' }, files, tools, new AbortController().signal)).verdict).toBe('AC')
    await fs.writeFile(files.output, '41\n')
    expect((await customCheck(exe, { kind: 'custom' }, files, tools, new AbortController().signal)).verdict).toBe('WA')
}, 30_000)

it('passes exactly the configured count and order of checker files', async () => {
    await fs.writeFile(
        path.join(dir, 'args.cpp'),
        '#include <bits/stdc++.h>\nint main(int argc,char**argv){for(int i=1;i<argc;i++){std::ifstream f(argv[i]);std::string s;f>>s;std::cerr<<s<<" ";}return 0;}'
    )
    const exe = await prepareTool(dir, 'args.cpp', tools)
    const files = {
        input: path.join(dir, 'input space'),
        output: path.join(dir, 'output space'),
        answer: path.join(dir, 'answer space'),
        score: ''
    }
    await Promise.all([
        fs.writeFile(files.input, 'IN'),
        fs.writeFile(files.output, 'OUT'),
        fs.writeFile(files.answer, 'ANS')
    ])
    for (const [args, message] of [
        ['{answer}', 'ANS'],
        ['{answer} {output}', 'ANS OUT'],
        ['{answer} {output} {input}', 'ANS OUT IN'],
        ['{answer} {answer}', 'ANS ANS'],
        ['', undefined]
    ]) {
        expect(
            await customCheck(exe, { kind: 'custom', args }, files, tools, new AbortController().signal)
        ).toMatchObject({ verdict: 'AC', checkerMessage: message })
    }
}, 30_000)
