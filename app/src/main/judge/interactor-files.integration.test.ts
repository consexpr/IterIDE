import { afterEach, beforeEach, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { JudgeEngine } from './engine'
import type { JudgeEvent, ToolchainSettings } from '../../shared/judge'
import type { JudgeSourceFile } from '../../shared/problem'
import {
    acquireProblemLease,
    attachFile,
    loadProblem,
    moveSource,
    patchProblem,
    problemDir,
    readInteractor,
    writeInteractor,
    writeTest
} from '../problem/store'
import { bundleRoot } from '../problem/resourceRuntime'

const tc: ToolchainSettings = {
    compiler: 'g++',
    flags: '-std=c++17 -O2 -Wall',
    debugFlags: '-std=c++17 -O0 -g',
    gdb: 'gdb',
    clangd: 'clangd',
    clangFormat: 'clang-format',
    parallel: 2,
    outputLimitBytes: 64 * 1024,
    displayLimitChars: 4000
}
const solution = '#include <cstdio>\nint main(){int x;if(scanf("%d",&x)!=1)return 1;printf("%d\\n",x);fflush(stdout);}'
const sources = (): JudgeSourceFile[] => [
    {
        name: 'protocol/interactor.cpp',
        code: '#include "testlib.h"\n#include "../include/protocol.h"\n#include <iostream>\nint main(int argc,char**argv){registerInteraction(argc,argv);int x=inf.readInt();std::cout<<challenge(x)<<std::endl;int got=ouf.readInt();if(got!=x+3)quitf(_wa,"unexpected reply %d",got);quitf(_ok,"accepted");}'
    },
    { name: 'helpers/protocol.cpp', code: '#include "../include/protocol.h"\nint challenge(int x){return x+3;}' },
    { name: 'include/protocol.h', code: '#pragma once\nint challenge(int x);' }
]
let root: string, src: string, engine: JudgeEngine, events: JudgeEvent[]
beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-interactor-files-'))
    const dir = path.join(root, '中文 空格')
    await fs.mkdir(dir)
    src = path.join(dir, 'solution.cpp')
    await fs.writeFile(src, solution)
    events = []
    engine = new JudgeEngine(
        () => tc,
        (event) => events.push(event)
    )
    await writeTest(src, { input: '42', answer: '45' })
    await patchProblem(src, { timeLimit: 2000 })
})
afterEach(async () => {
    await engine.dispose()
    const target = path.resolve(root)
    if (
        path.dirname(target) !== path.resolve(os.tmpdir()) ||
        !path.basename(target).startsWith('iter-interactor-files-')
    )
        throw new Error('Unexpected test cleanup path')
    await fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})
async function run(code = solution): Promise<JudgeEvent[]> {
    const id = await engine.run({ sourcePath: src, source: code })
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            clearInterval(poll)
            reject(new Error('Judge timed out'))
        }, 25_000)
        const poll = setInterval(() => {
            if (events.some((event) => event.runId === id && event.type === 'done')) {
                clearTimeout(timer)
                clearInterval(poll)
                resolve()
            }
        }, 10)
    })
    return events.filter((event) => event.runId === id)
}
const summary = (items: JudgeEvent[]) => items.find((event) => event.type === 'done')

it('persists and links multiple pasted CPP files and headers, and rebuilds after an auxiliary edit', async () => {
    const files = sources()
    const saved = await writeInteractor(src, files)
    expect(saved.tests).toHaveLength(1)
    expect(await readInteractor(src)).toEqual(files)
    expect(summary(await run())).toMatchObject({ summary: { verdict: 'AC', passed: 1 } })
    const previous = path.join(problemDir(src), saved.interactor!.files![0])
    const changed = sources()
    changed[1].code = changed[1].code.replace('x+3', 'x+4')
    await writeInteractor(src, changed)
    expect(await fs.readFile(previous, 'utf8')).toBe(files[1].code)
    expect(summary(await run())).toMatchObject({ summary: { verdict: 'WA', passed: 0 } })
}, 30_000)

it('retains editable compiler errors and identifies the failing auxiliary file', async () => {
    const files = sources()
    files[1].code = 'int challenge(int x){return missing_identifier;}'
    await writeInteractor(src, files)
    const result = await run()
    expect(summary(result)).toMatchObject({ summary: { verdict: 'SE' } })
    expect(result.find((event) => event.type === 'error')).toMatchObject({
        message: expect.stringContaining('protocol.cpp')
    })
    expect(await readInteractor(src)).toEqual(files)
}, 30_000)

it('preserves the files after moving the solution, and refuses changes during a leased run', async () => {
    await writeInteractor(src, sources())
    const release = await acquireProblemLease(src)
    try {
        await expect(writeInteractor(src, sources())).rejects.toThrow('正在运行')
    } finally {
        release()
    }
    const next = path.join(path.dirname(src), 'renamed.cpp')
    await fs.rename(src, next)
    await moveSource(src, next)
    src = next
    expect(await readInteractor(src)).toEqual(sources())
    expect(summary(await run())).toMatchObject({ summary: { verdict: 'AC' } })
}, 30_000)

it('rejects traversal and duplicate names without replacing the working interactor', async () => {
    await writeInteractor(src, sources())
    for (const invalid of [
        [{ name: '../outside.cpp', code: 'int main(){}' }],
        [
            { name: 'x.cpp', code: 'int main(){}' },
            { name: 'X.cpp', code: 'int extra;' }
        ]
    ])
        await expect(writeInteractor(src, invalid)).rejects.toThrow()
    expect(await readInteractor(src)).toEqual(sources())
})

it('prefers an explicitly supplied testlib header over the bundled fallback', async () => {
    await writeInteractor(src, [
        {
            name: 'interactor.cpp',
            code: '#include "testlib.h"\n#include <cstdio>\nint main(){printf("%d\\n",magic());fflush(stdout);int x;return scanf("%d",&x)==1 && x==magic()?0:1;}'
        },
        { name: 'headers/testlib.h', code: '#pragma once\ninline int magic(){return 123;}' }
    ])
    expect(summary(await run())).toMatchObject({ summary: { verdict: 'AC' } })
}, 30_000)

it('retains imported runtime assets when editing code and after the old bundle is removed', async () => {
    const directory = path.join(root, 'imported')
    await fs.mkdir(directory)
    await fs.writeFile(path.join(directory, 'seed.txt'), '42')
    const interactor = path.join(directory, 'interactor.cpp')
    await fs.writeFile(
        interactor,
        '#include <fstream>\n#include <cstdio>\nint main(){std::ifstream f("seed.txt");int secret=0;f>>secret;printf("%d\\n",secret);fflush(stdout);int x=0;return scanf("%d",&x)==1&&x==42?0:1;}'
    )
    const relative = await attachFile(src, interactor, 'interactor')
    await patchProblem(src, { mode: 'interactive', interactor: { path: relative } })
    expect(summary(await run())).toMatchObject({ summary: { verdict: 'AC' } })
    const original = bundleRoot(path.join(problemDir(src), relative))!
    const files = (await readInteractor(src))!
    files[0].code += '\n// edited in the application\n'
    await writeInteractor(src, files)
    if (path.dirname(original) !== path.join(problemDir(src), 'resources'))
        throw new Error('Unexpected bundle cleanup path')
    await fs.rm(original, { recursive: true, force: true })
    expect(summary(await run())).toMatchObject({ summary: { verdict: 'AC' } })
}, 30_000)

it('still links a grader main with a function-only solution and judges its output', async () => {
    await fs.writeFile(
        path.join(path.dirname(src), 'grader.cpp'),
        '#include <cstdio>\nint solve(int);int main(){int x;scanf("%d",&x);printf("%d",solve(x));}'
    )
    await patchProblem(src, { mode: 'grader', grader: { sources: ['grader.cpp'] } })
    await writeTest(src, { id: '1', input: '21', answer: '42' })
    expect(summary(await run('int solve(int x){return x*2;}'))).toMatchObject({ summary: { verdict: 'AC' } })
    expect((await loadProblem(src)).grader?.sources).toHaveLength(1)
}, 30_000)
