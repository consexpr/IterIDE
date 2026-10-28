import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { JudgeEngine } from './engine'
import { getRunner } from './runner'
import { runTest } from './run'
import { importTestFiles, loadProblem, problemDir, saveProblem, writeTest } from '../problem/store'
import type { JudgeEvent, TestResult, ToolchainSettings } from '../../shared/judge'

const settings: ToolchainSettings = {
    compiler: 'g++',
    flags: '-std=c++17 -O2 -Wall',
    debugFlags: '-std=c++17 -O0 -g',
    gdb: 'gdb',
    clangd: 'clangd',
    clangFormat: 'clang-format',
    parallel: 2,
    outputLimitBytes: 64 * 1024,
    displayLimitChars: 1000
}
const echo = '#include <cstdio>\nint main(){int x; scanf("%d",&x); printf("%d\\n",x); fprintf(stderr,"cerr!\\n");}'

describe('judge engine with real g++ programs', () => {
    let dir: string, src: string, engine: JudgeEngine, events: JudgeEvent[], tc: ToolchainSettings
    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-judge-test-'))
        src = path.join(dir, 'main.cpp')
        tc = { ...settings }
        events = []
        engine = new JudgeEngine(
            () => tc,
            (e) => events.push(e)
        )
    })
    afterEach(async () => {
        await engine.stop()
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    })

    async function run(
        source: string,
        testIds?: string[]
    ): Promise<{ tests: TestResult[]; summary: Extract<JudgeEvent, { type: 'done' }>['summary'] }> {
        const id = await engine.run({ sourcePath: src, source, testIds })
        await new Promise<void>((resolve, reject) => {
            const deadline = setTimeout(() => {
                clearInterval(poll)
                reject(new Error(`Judge did not finish: ${JSON.stringify(events)}`))
            }, 35_000)
            const poll = setInterval(() => {
                if (events.some((e) => e.runId === id && e.type === 'done')) {
                    clearTimeout(deadline)
                    clearInterval(poll)
                    resolve()
                }
            }, 10)
        })
        const runEvents = events.filter((e) => e.runId === id)
        return {
            tests: runEvents
                .filter((e): e is Extract<JudgeEvent, { type: 'test-done' }> => e.type === 'test-done')
                .map((e) => e.result),
            summary: (runEvents.find((e) => e.type === 'done') as Extract<JudgeEvent, { type: 'done' }>).summary
        }
    }

    it('judges AC/WA/NA, preserves stderr, and summarizes in test order', async () => {
        await writeTest(src, { input: '4', answer: '4' })
        await writeTest(src, { input: '4', answer: '5' })
        await writeTest(src, { input: '4', answer: '' })
        const result = await run(echo)
        const ordered = result.tests.sort((a, b) => Number(a.testId) - Number(b.testId))
        expect(ordered.map((t) => t.verdict)).toEqual(['AC', 'WA', 'NA'])
        expect(ordered[0].stderr).toContain('cerr!')
        expect(ordered[1].checkerMessage).toContain('expected "5", found "4"')
        expect(result.summary).toEqual({ total: 3, passed: 1, verdict: 'WA' })
        expect(events.map((e) => e.type).slice(0, 2)).toEqual(['compile-start', 'compile-done'])
    }, 40_000)

    it('finishes normally after repeated cin reads in the EOF fail state with parallel linked and copied tests', async () => {
        tc.parallel = 4
        tc.flags = '-std=c++17 -O2 -Wall -Wextra -Wshadow'
        // one file pair per test: importing the *same* linked files twice is deduplicated by design
        for (const [i, link] of [true, false, true, false].entries()) {
            const input = path.join(dir, `past-eof-${i}.in`),
                answer = path.join(dir, `past-eof-${i}.ans`)
            await fs.writeFile(input, '6\n2 3\n7 11')
            await fs.writeFile(answer, '23')
            await importTestFiles(src, { name: `eof-${i}-${link}`, input, answer }, link)
        }
        const result = await run(`#include <iostream>
int main() {
    std::ios::sync_with_stdio(false); std::cin.tie(nullptr);
    int count = 0, sum = 0;
    std::cin >> count;
    for (int i = 0; i < count; ++i) {
        int a = 0, b = 0;
        std::cin >> a >> b;
        if (std::cin) sum += a + b;
        else {
            if (!std::cin.fail() || !std::cin.eof()) return 20;
            int unchanged = 123;
            std::cin >> unchanged;
            if (unchanged != 123 || !std::cin.fail()) return 21;
        }
    }
    std::cout << sum;
}`)
        expect(result.tests).toHaveLength(4)
        for (const test of result.tests) {
            expect(test, JSON.stringify(test)).toMatchObject({ verdict: 'AC', exitCode: 0, output: '23' })
            expect(test.timeMs).toBeLessThan(1000)
            expect(test.memoryKb, 'must use the helper').toBeTypeOf('number')
        }
    }, 40_000)

    it('caches builds, honors source includes/extra flags, and maps CE diagnostics', async () => {
        await fs.writeFile(path.join(dir, 'value.h'), '#define VALUE 9')
        const code = '#include "value.h"\n#ifndef EXTRA\n#error missing extra flag\n#endif\nint main(){return VALUE-9;}'
        const cfg = await loadProblem(src)
        cfg.extraFlags = '-DEXTRA'
        await saveProblem(src, cfg)
        expect((await engine.compile(src, code, false)).ok).toBe(true)
        expect((await engine.compile(src, code, false)).cached).toBe(true)
        expect((await engine.compile(src, code, true)).ok).toBe(true)
        const bad = await engine.compile(src, 'int main(){ not_declared; }', false)
        expect(bad.ok).toBe(false)
        expect(bad.diagnostics[0].file).toBe(src)
        expect((await run('int main( {')).summary.verdict).toBe('CE')
    }, 40_000)

    it('kills an infinite loop at 300 ms and reports abort as RE', async () => {
        await writeTest(src, { input: '', answer: 'ok' })
        const cfg = await loadProblem(src)
        cfg.timeLimit = 300
        await saveProblem(src, cfg)
        const loop = await run('int main(){for(;;){}}')
        expect(loop.tests[0].verdict).toBe('TLE')
        expect(loop.tests[0].timeMs).toBeGreaterThanOrEqual(cfg.timeLimit)
        expect(loop.tests[0].timeMs).toBeLessThan(2500)
        expect((await run('#include <cstdlib>\nint main(){abort();}')).tests[0].verdict).toBe('RE')
    }, 40_000)

    it('limits memory with the native helper', async (context) => {
        if (!(await getRunner(tc))) {
            context.skip()
            return
        }
        await writeTest(src, { input: '', answer: 'ok' })
        const cfg = await loadProblem(src)
        cfg.memoryLimit = 64
        await saveProblem(src, cfg)
        const result = await run(
            '#include <vector>\nint main(){std::vector<char> v(300u*1024*1024); volatile char* p=v.data(); for(unsigned i=0;i<v.size();i+=4096)p[i]=1;}'
        )
        expect(result.tests[0].memoryKb).toBeTypeOf('number')
        expect(result.tests[0].verdict).toBe('MLE')
    }, 40_000)

    it('runs file IO in isolated directories and reports missing outputs', async () => {
        await writeTest(src, { input: '17', answer: '17' })
        await writeTest(src, { input: '29', answer: '29' })
        const cfg = await loadProblem(src)
        cfg.fileIO = { enabled: true, input: 'data.in', output: 'data.out' }
        await saveProblem(src, cfg)
        const code =
            '#include <cstdio>\nint main(){int x; FILE* f=fopen("data.in","r"); fscanf(f,"%d",&x); fclose(f); f=fopen("data.out","w"); fprintf(f,"%d",x); fclose(f); puts("debug stdout"); fprintf(stderr,"debug stderr");}'
        const result = await run(code)
        expect(result.tests.every((t) => t.verdict === 'AC')).toBe(true)
        expect(result.tests[0].stderr).toContain('[stdout]\ndebug stdout')
        expect(result.tests[0].stderr).toContain('debug stderr')
        const missing = await run('int main(){}')
        expect(missing.tests[0].verdict).toBe('WA')
        expect(missing.tests[0].checkerMessage).toBe('output file data.out not produced')
    }, 40_000)

    it('compiles and runs a testlib special judge', async () => {
        await writeTest(src, { input: '4', answer: '8' })
        await fs.writeFile(
            path.join(problemDir(src), 'checker.cpp'),
            '#include "testlib.h"\nint main(int argc,char** argv){registerTestlibCmd(argc,argv);int x=ouf.readInt(), y=ans.readInt();if(x!=y)quitf(_wa,"expected %d, found %d",y,x);quitf(_ok,"correct");}'
        )
        const cfg = await loadProblem(src)
        cfg.mode = 'spj'
        cfg.checker = { kind: 'custom', path: 'checker.cpp' }
        await saveProblem(src, cfg)
        expect((await run('#include <cstdio>\nint main(){puts("8");}')).tests[0]).toMatchObject({
            verdict: 'AC',
            checkerMessage: expect.stringContaining('correct')
        })
        expect((await run(echo)).tests[0].verdict).toBe('WA')
    }, 40_000)

    it('cross-connects a testlib guess-number interactor', async () => {
        await writeTest(src, { input: '42', answer: '42' })
        await fs.writeFile(
            path.join(problemDir(src), 'interactor.cpp'),
            '#include "testlib.h"\n#include <iostream>\nint main(int argc,char** argv){registerInteraction(argc,argv);int secret=inf.readInt();std::cout<<100<<std::endl;for(int i=0;i<10;i++){int x=ouf.readInt(1,100);tout<<x<<std::endl;if(x==secret){std::cout<<"OK"<<std::endl;quitf(_ok,"guessed %d",x);}std::cout<<(x<secret?"HIGHER":"LOWER")<<std::endl;}quitf(_wa,"too many guesses");}'
        )
        const cfg = await loadProblem(src)
        cfg.mode = 'interactive'
        cfg.timeLimit = 2000
        cfg.interactor = { path: 'interactor.cpp' }
        await saveProblem(src, cfg)
        const code =
            '#include <cstdio>\n#include <cstring>\nint main(){int hi;scanf("%d",&hi);int lo=1;char s[20];while(lo<=hi){int m=(lo+hi)/2;printf("%d\\n",m);fflush(stdout);if(scanf("%19s",s)!=1)return 0;if(!strcmp(s,"OK"))return 0;if(!strcmp(s,"HIGHER"))lo=m+1;else hi=m-1;}}'
        const result = await run(code)
        expect(result.tests[0].verdict).toBe('AC')
        expect(result.tests[0].interactorLog).toContain('guessed 42')
        expect(result.tests[0].memoryKb).toBeUndefined()
        expect((await run('int main(){return 1;}')).tests[0].verdict).toBe('RE')
        expect(
            (await run('#include <cstdio>\nint main(){for(int i=0;i<10;i++)puts("50");fflush(stdout);for(;;){}}'))
                .tests[0].verdict
        ).toBe('WA')
        expect((await run('int main(){for(;;){}}')).tests[0].verdict).toBe('TLE')
        await writeTest(src, { id: '1', input: '42', answer: '' })
        expect((await run(code)).tests[0].verdict).toBe('NA')
    }, 40_000)

    it('enforces output limits and bounded display', async () => {
        await writeTest(src, { input: '', answer: 'ok' })
        const cfg = await loadProblem(src)
        // Exercise the output budget without racing the default one-second wall limit on busy CI hosts.
        cfg.timeLimit = 5000
        await saveProblem(src, cfg)
        tc.displayLimitChars = 20
        const result = await run(
            '#include <cstdio>\nint main(){for(;;)puts("0123456789012345678901234567890123456789");}'
        )
        expect(result.tests[0].verdict).toBe('OLE')
        expect(result.tests[0].output.length).toBeLessThanOrEqual(20)
        expect(result.tests[0].truncated).toBe(true)
        cfg.fileIO = { enabled: true, input: 'data.in', output: 'data.out' }
        await saveProblem(src, cfg)
        expect(
            (
                await run(
                    '#include <cstdio>\nint main(){FILE* f=fopen("data.out","w"); for(int i=0;i<100000;i++)fputs("0123456789",f);fclose(f);}'
                )
            ).tests[0].verdict
        ).toBe('OLE')
    }, 40_000)

    it('supports plain-spawn fallback and early stdin closure on large inputs', async () => {
        await writeTest(src, { input: 'unused input\n'.repeat(100_000), answer: 'ok' })
        const cfg = await loadProblem(src)
        const compiled = await engine.compile(src, '#include <cstdio>\nint main(){puts("ok");}', false)
        const result = await runTest({
            src,
            exe: compiled.exe!,
            cfg,
            test: cfg.tests[0],
            tc,
            signal: new AbortController().signal
        })
        expect(result.verdict).toBe('AC')
        expect(result.memoryKb).toBeUndefined()
    }, 40_000)

    it('honors disabled cases, explicit selection, and per-case time limits', async () => {
        await writeTest(src, { input: '', answer: 'ok' })
        await writeTest(src, { input: '', answer: 'ok' })
        const cfg = await loadProblem(src)
        cfg.timeLimit = 1500
        cfg.tests[0].enabled = false
        cfg.tests[1].timeLimit = 300
        await saveProblem(src, cfg)
        const result = await run('int main(){for(;;){}}')
        expect(result.summary.total).toBe(1)
        expect(result.tests[0]).toMatchObject({ testId: '2', verdict: 'TLE' })
        expect((await run('#include <cstdio>\nint main(){puts("ok");}', ['1'])).tests[0]).toMatchObject({
            testId: '1',
            verdict: 'AC'
        })
    }, 40_000)

    it('stops an active run and cancels stale syntax checks', async () => {
        await writeTest(src, { input: '', answer: 'ok' })
        const id = await engine.run({ sourcePath: src, source: 'int main(){for(;;){}}' })
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                clearInterval(poll)
                reject(new Error('Run did not start'))
            }, 10_000)
            const poll = setInterval(() => {
                if (events.some((e) => e.type === 'test-start')) {
                    clearTimeout(timeout)
                    clearInterval(poll)
                    resolve()
                }
            }, 10)
        })
        await new Promise((resolve) => setTimeout(resolve, 50))
        await engine.stop(id)
        expect(events.some((e) => e.type === 'done' && e.summary.verdict === 'SE')).toBe(true)
        const first = engine.syntaxCheck(src, 'int main(){ nope; }')
        const second = engine.syntaxCheck(src, 'int main(){ unknown; }')
        expect(await first).toEqual([])
        expect((await second)[0]).toMatchObject({ file: src, line: 1, severity: 'error' })
    }, 40_000)
})
