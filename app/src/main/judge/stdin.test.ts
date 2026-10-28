import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compileSource } from './compile'
import { getRunner } from './runner'
import { runTest } from './run'
import { importTestFiles, loadProblem } from '../problem/store'
import type { ToolchainSettings } from '../../shared/judge'

const tc: ToolchainSettings = {
    compiler: 'g++',
    flags: '-std=c++17 -O2',
    debugFlags: '-std=c++17 -O0 -g',
    gdb: 'gdb',
    clangd: 'clangd',
    clangFormat: 'clang-format',
    parallel: 2,
    outputLimitBytes: 64 * 1024,
    displayLimitChars: 1000
}
const readers = [
    ['cin', '#include <iostream>\nint main(){int x,s=0; while(std::cin >> x)s+=x; std::cout<<s;}'],
    [
        'cin unsynced',
        '#include <iostream>\nint main(){std::ios::sync_with_stdio(false); std::cin.tie(nullptr); int x,s=0; while(std::cin >> x)s+=x; std::cout<<s;}'
    ],
    [
        'cin failed reads',
        '#include <iostream>\nint main(){std::ios::sync_with_stdio(false); int x=0,s=0; while(std::cin >> x)s+=x; for(int i=0;i<4;i++){int unchanged=123; std::cin>>unchanged; if(!std::cin.fail()||!std::cin.eof()||unchanged!=123)return 1;} std::cout<<s;}'
    ],
    ['scanf', '#include <cstdio>\nint main(){int x,s=0; while(scanf("%d",&x)!=EOF)s+=x; printf("%d",s);}'],
    [
        'getchar',
        "#include <cstdio>\nint main(){int c,s=0; while((c=getchar())!=EOF)if(c>='0'&&c<='9')s+=c-'0'; printf(\"%d\",s);}"
    ]
] as const

describe('batch stdin and time limits with real C++ programs', () => {
    let dir: string, src: string
    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-stdin-test-'))
        // Spaces and non-ASCII names also exercise the helper's Windows handle path.
        src = path.join(dir, '读到 EOF.cpp')
    })
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    })

    it.each(['helper', 'fallback'] as const)(
        '%s reaches EOF for copied and linked inputs',
        async (mode) => {
            const runner = mode === 'helper' ? await getRunner(tc) : undefined
            if (mode === 'helper') expect(runner, 'native helper must be available').toBeTruthy()
            for (const [index, input] of ['', '1 2 3', '1 2 3\n'].entries()) {
                const inputFile = path.join(dir, `数据 ${index}.in`),
                    answerFile = path.join(dir, `数据 ${index}.ans`)
                await fs.writeFile(inputFile, input)
                await fs.writeFile(answerFile, input ? '6' : '0')
                for (const link of [false, true])
                    await importTestFiles(src, { name: `${index}-${link}`, input: inputFile, answer: answerFile }, link)
            }
            const cfg = await loadProblem(src)
            for (const [name, source] of readers) {
                const build = await compileSource(src, source, tc, false)
                expect(build.ok, build.output).toBe(true)
                for (const test of cfg.tests) {
                    const result = await runTest({
                        src,
                        exe: build.exe!,
                        cfg,
                        test,
                        tc,
                        runner,
                        signal: new AbortController().signal
                    })
                    expect(result.verdict, `${name}/${test.name}: ${JSON.stringify(result)}`).toBe('AC')
                    expect(result.timeMs).toBeLessThan(cfg.timeLimit)
                    if (runner) expect(result.memoryKb, 'must execute through the native helper').toBeTypeOf('number')
                }
            }
        },
        40_000
    )

    it.each(['helper', 'fallback'] as const)(
        '%s reports a genuine TLE at or above the case limit',
        async (mode) => {
            const runner = mode === 'helper' ? await getRunner(tc) : undefined
            if (mode === 'helper') expect(runner).toBeTruthy()
            const input = path.join(dir, 'slow.in'),
                answer = path.join(dir, 'slow.ans')
            await fs.writeFile(input, '')
            await fs.writeFile(answer, 'ok')
            await importTestFiles(src, { name: 'slow', input, answer }, true)
            const cfg = await loadProblem(src)
            cfg.tests[0].timeLimit = 300
            const build = await compileSource(src, 'int main(){for(;;){}}', tc, false)
            expect(build.ok, build.output).toBe(true)
            const result = await runTest({
                src,
                exe: build.exe!,
                cfg,
                test: cfg.tests[0],
                tc,
                runner,
                signal: new AbortController().signal
            })
            expect(result.verdict).toBe('TLE')
            expect(result.timeMs).toBeGreaterThanOrEqual(300)
        },
        40_000
    )

    it('explains a native wall-clock kill with very little CPU use', async () => {
        const runner = await getRunner(tc)
        expect(runner).toBeTruthy()
        const input = path.join(dir, 'waiting.in'),
            answer = path.join(dir, 'waiting.ans')
        await fs.writeFile(input, '')
        await fs.writeFile(answer, 'ok')
        await importTestFiles(src, { name: 'waiting', input, answer }, false)
        const cfg = await loadProblem(src)
        cfg.tests[0].timeLimit = 300
        const build = await compileSource(
            src,
            '#include <thread>\n#include <chrono>\nint main(){std::this_thread::sleep_for(std::chrono::seconds(5));}',
            tc,
            false
        )
        expect(build.ok, build.output).toBe(true)
        const result = await runTest({
            src,
            exe: build.exe!,
            cfg,
            test: cfg.tests[0],
            tc,
            runner,
            signal: new AbortController().signal
        })
        expect(result.verdict).toBe('TLE')
        // The wall deadline includes 100 ms of grace, while CPU time is near zero.
        expect(result.timeMs).toBeGreaterThanOrEqual(400)
        expect(result.checkerMessage).toBe('等待输入超时（程序可能还在读取输入）')
    }, 40_000)

    it('reopens finite stdin when helper setup fails and falls back to spawn', async () => {
        const input = path.join(dir, 'fallback.in'),
            answer = path.join(dir, 'fallback.ans')
        await fs.writeFile(input, '1 2 3')
        await fs.writeFile(answer, '6')
        for (const link of [false, true]) await importTestFiles(src, { name: `fallback-${link}`, input, answer }, link)
        const cfg = await loadProblem(src)
        // Exit 125 without accounting is the native helper's setup-failure protocol.
        const broken = await compileSource(
            path.join(dir, 'unavailable.cpp'),
            '#include <cstdio>\nint main(){getchar();return 125;}',
            tc,
            false
        )
        const build = await compileSource(src, readers.find(([name]) => name === 'scanf')![1], tc, false)
        expect(broken.ok, broken.output).toBe(true)
        expect(build.ok, build.output).toBe(true)
        for (const test of cfg.tests) {
            const result = await runTest({
                src,
                exe: build.exe!,
                cfg,
                test,
                tc,
                runner: broken.exe,
                signal: new AbortController().signal
            })
            expect(result.verdict, JSON.stringify(result)).toBe('AC')
            expect(result.memoryKb).toBeUndefined()
        }
    }, 40_000)
})
