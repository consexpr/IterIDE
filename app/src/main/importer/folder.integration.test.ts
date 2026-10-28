import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JudgeEvent, TestResult, ToolchainSettings } from '../../shared/judge'
import { JudgeEngine } from '../judge/engine'
import { applyFolder, previewFolder } from './folder'
import { loadProblem, saveProblem } from '../problem/store'

const tc: ToolchainSettings = {
    compiler: 'g++',
    flags: '-std=c++17 -O2 -Wall',
    debugFlags: '-std=c++17 -O0 -g',
    gdb: 'gdb',
    clangd: 'clangd',
    clangFormat: 'clang-format',
    parallel: 1,
    outputLimitBytes: 1_000_000,
    displayLimitChars: 1000
}
const realSamples = path.resolve(import.meta.dirname, '../../../../smp')
let dir: string, engine: JudgeEngine, events: JudgeEvent[]
beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-folder-integration-'))
    vi.stubEnv('ITER_STORE', path.join(dir, '.store'))
    events = []
    engine = new JudgeEngine(
        () => tc,
        (event) => events.push(event)
    )
})
afterEach(async () => {
    vi.unstubAllEnvs()
    await engine.stop()
    if (path.dirname(dir) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('iter-folder-integration-'))
        throw new Error('Invalid integration cleanup path')
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 })
})
async function files(contents: Record<string, string>): Promise<void> {
    for (const [name, content] of Object.entries(contents)) {
        const file = path.join(dir, name)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, content)
    }
}
async function run(sourcePath: string, source: string): Promise<TestResult[]> {
    const id = await engine.run({ sourcePath, source })
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            clearInterval(poll)
            reject(new Error(`Judge timed out: ${JSON.stringify(events)}`))
        }, 35_000)
        const poll = setInterval(() => {
            if (events.some((event) => event.runId === id && event.type === 'done')) {
                clearTimeout(timeout)
                clearInterval(poll)
                resolve()
            }
        }, 10)
    })
    const selected = events.filter((event) => event.runId === id)
    expect(selected.filter((event) => event.type === 'error')).toEqual([])
    expect(
        selected.find((event) => event.type === 'compile-done'),
        JSON.stringify(selected)
    ).toMatchObject({ result: { ok: true } })
    return selected
        .filter((event): event is Extract<JudgeEvent, { type: 'test-done' }> => event.type === 'test-done')
        .map((event) => event.result)
}
async function importFolder(folder: string, code: string, filename = 'T2.cpp'): Promise<string> {
    const problem = (await previewFolder(folder)).problems[0]
    const sourcePath = path.join(folder, filename)
    await applyFolder({ problem, sourcePath, initialCode: code, link: true, replaceTests: true })
    return sourcePath
}

describe('folder imports with the real compiler and judge', () => {
    it('runs linked SPJ data, prefers the local testlib, and supports a solution outside the data folder', async () => {
        await files({
            'bot/bot1.in': '4',
            'bot/bot1.ans': '8',
            'bot/testlib.h': '#define ITER_LOCAL_TESTLIB 1\n',
            'bot/checker.cpp':
                '#include "testlib.h"\n#ifndef ITER_LOCAL_TESTLIB\n#error wrong testlib\n#endif\n#include <fstream>\nint main(int argc,char** argv){int a,b;std::ifstream(argv[2])>>a;std::ifstream(argv[3])>>b;return a==b?0:1;}'
        })
        const source = '#include <cstdio>\nint main(){int n;scanf("%d",&n);printf("%d",n*2);}'
        const problem = (await previewFolder(path.join(dir, 'bot'))).problems[0]
        const sourcePath = path.join(dir, 'solutions', '未命名1.cpp')
        await applyFolder({ problem, sourcePath, initialCode: source, link: true, replaceTests: true })
        expect((await loadProblem(sourcePath)).checker).toMatchObject({
            kind: 'custom',
            path: expect.stringMatching(/^resources\//)
        })
        await fs.rm(path.join(dir, 'bot'), { recursive: true })
        await fs.rm(path.join(dir, 'solutions'), { recursive: true })
        expect((await run(sourcePath, source)).map((test) => test.verdict)).toEqual(['AC'])
    }, 40_000)

    it('owns grader dependencies after deleting originals and invalidates compiled cache when cached dependencies change', async () => {
        await files({
            'perm/perm1.in': '4',
            'perm/perm1.out': '5',
            'perm/perm.h': 'int perm(int n);\n#define OFFSET 0\n',
            'perm/template_perm.cpp': '#include "perm.h"\nint perm(int n){return n+1;}',
            'perm/grader.cpp':
                '#include "perm.h"\n#include <cstdio>\nint main(){int n;scanf("%d",&n);printf("%d",perm(n)+OFFSET);}'
        })
        const source = await fs.readFile(path.join(dir, 'perm', 'template_perm.cpp'), 'utf8')
        const sourcePath = await importFolder(path.join(dir, 'perm'), source)
        const first = await engine.compile(sourcePath, source, false)
        expect(first.ok, first.output).toBe(true)
        expect((await engine.compile(sourcePath, source, false)).cached).toBe(true)
        expect((await run(sourcePath, source))[0].verdict).toBe('AC')
        const cached = await loadProblem(sourcePath)
        const cachedGrader = cached.grader!.sources[0]
        await fs.rm(path.join(dir, 'perm'), { recursive: true })
        expect((await run(sourcePath, source))[0].verdict).toBe('AC')
        await fs.appendFile(cachedGrader, '\n// grader revision\n')
        const changed = await engine.compile(sourcePath, source, false)
        expect(changed.ok, changed.output).toBe(true)
        expect(changed.exe).not.toBe(first.exe)
        expect(changed.cached).toBe(false)
        await fs.writeFile(path.join(path.dirname(cachedGrader), 'perm.h'), 'int perm(int n);\n#define OFFSET 1\n')
        const headerChanged = await engine.compile(sourcePath, source, false)
        expect(headerChanged.exe).not.toBe(changed.exe)
        expect((await run(sourcePath, source))[0].verdict).toBe('WA')
        const badUser = await engine.compile(sourcePath, '#include "perm.h"\nint perm(int n){return unknown;}', false)
        expect(badUser.diagnostics.some((diagnostic) => diagnostic.file === sourcePath && diagnostic.line === 2)).toBe(
            true
        )
        const graderPath = cachedGrader
        await fs.writeFile(graderPath, 'int main(){missing;}')
        const badGrader = await engine.compile(sourcePath, source, false)
        expect(badGrader.diagnostics.some((diagnostic) => diagnostic.file === graderPath)).toBe(true)
        await fs.rm(graderPath)
        const missing = await engine.compile(sourcePath, source, false)
        expect(missing).toMatchObject({ ok: false, output: expect.stringContaining('Cannot read grader source') })
    }, 40_000)

    it('runs an interactor with nested local headers after deleting the entire original folder', async () => {
        await files({
            'interactive/1.in': '4',
            'interactive/1.ans': '8',
            'interactive/helper/value.h': '#pragma once\n#define VALUE 4',
            'interactive/interactor.cpp':
                '#include "helper/value.h"\n#include <iostream>\nint main(){std::cout<<VALUE<<std::endl;int n;std::cin>>n;return n==VALUE*2?0:1;}'
        })
        const source = '#include <iostream>\nint main(){int n;std::cin>>n;std::cout<<n*2<<std::endl;}'
        const sourcePath = await importFolder(path.join(dir, 'interactive'), source)
        await fs.rm(path.join(dir, 'interactive'), { recursive: true })
        expect((await run(sourcePath, source))[0].verdict).toBe('AC')
    }, 40_000)

    it('owns header search paths and forced includes before the original source is deleted', async () => {
        const source = '#include "api.h"\n#include <cstdio>\nint main(){printf("%d", VALUE + FORCED);}'
        await files({
            'flags/1.in': '',
            'flags/1.ans': '9',
            'flags/T2.cpp': source,
            'flags/headers/api.h': '#define VALUE 4',
            'flags/headers/forced.h': '#define FORCED 5'
        })
        const sourcePath = path.join(dir, 'flags', 'T2.cpp')
        await importFolder(path.join(dir, 'flags'), source)
        const cfg = await loadProblem(sourcePath)
        cfg.extraFlags = '-I headers -include headers/forced.h'
        await saveProblem(sourcePath, cfg)
        await fs.rm(path.join(dir, 'flags'), { recursive: true })
        expect((await run(sourcePath, source))[0].verdict).toBe('AC')
        expect(await engine.syntaxCheck(sourcePath, source)).toEqual([])
    }, 40_000)

    it('runs linked data without answers and compiles graders using configured include directories', async () => {
        await files({
            'input.in': '4',
            'headers/api.h': 'int solve(int);',
            'driver.cpp': '#include "api.h"\n#include <cstdio>\nint main(){int x;scanf("%d",&x);printf("%d",solve(x));}'
        })
        const source = '#include "api.h"\nint solve(int x){return x+1;}'
        const sourcePath = await importFolder(dir, source)
        const config = await loadProblem(sourcePath)
        config.grader = { sources: ['driver.cpp'], includeDirs: ['headers'] }
        await saveProblem(sourcePath, config)
        expect((await run(sourcePath, source))[0].verdict).toBe('NA')
    }, 40_000)

    it.skipIf(!existsSync(path.join(realSamples, '10.19down', 'bot', 'checker.cpp')))(
        'runs a copied real bot sample through its checker as AC',
        async () => {
            const folder = path.join(dir, 'bot')
            await fs.mkdir(folder)
            for (const file of ['bot1.in', 'bot1.ans', 'checker.cpp', 'testlib.h'])
                await fs.copyFile(path.join(realSamples, '10.19down', 'bot', file), path.join(folder, file))
            const answer = await fs.readFile(path.join(folder, 'bot1.ans'), 'utf8')
            const source = `#include <cstdio>\nint main(){fputs(${JSON.stringify(answer)},stdout);}`
            const sourcePath = await importFolder(folder, source)
            expect((await run(sourcePath, source))[0].verdict).toBe('AC')
        },
        40_000
    )

    it.skipIf(!existsSync(path.join(realSamples, '10.17down', 'perm', 'grader.cpp')))(
        'compiles and runs the copied real perm grader and template (WA/RE expected)',
        async () => {
            const folder = path.join(dir, 'perm')
            await fs.mkdir(folder)
            for (const file of ['perm1.in', 'perm1.ans', 'perm.h', 'grader.cpp', 'template_perm.cpp', '未命名1.cpp'])
                await fs.copyFile(path.join(realSamples, '10.17down', 'perm', file), path.join(folder, file))
            const preview = (await previewFolder(folder)).problems[0]
            expect(preview.sources).toEqual([])
            expect(preview.template).toBe(path.join(folder, 'template_perm.cpp'))
            expect(preview.notes).toContain('未命名1.cpp 含 main，不作为解答')
            // The two-element real sample happens to accept the template; exercise its invalid query at n=3 too.
            await fs.writeFile(path.join(folder, 'perm2.in'), '1 3\n0 1 2\n')
            await fs.writeFile(path.join(folder, 'perm2.ans'), '0\n')
            const source = await fs.readFile(path.join(folder, 'template_perm.cpp'), 'utf8')
            const sourcePath = await importFolder(folder, source, 'perm.cpp')
            expect((await loadProblem(sourcePath)).grader).toEqual({ sources: ['grader.cpp'], includeDirs: ['.'] })
            const results = await run(sourcePath, source)
            expect(results.map((result) => result.verdict)).toEqual(['AC', 'WA'])
        },
        40_000
    )
})
