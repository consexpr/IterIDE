import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { testFilePaths } from '../problem/store'
import { defaultProblem } from '../../shared/problem'
import type { ToolchainSettings } from '../../shared/judge'
import { compileSource } from './compile'
import { runTest } from './run'
import { runInteractive } from './interactive'
import { customCheck } from './checkers'

const tc: ToolchainSettings = {
    compiler: 'g++',
    flags: '-std=c++17 -O2',
    debugFlags: '-g',
    gdb: 'gdb',
    clangd: 'clangd',
    clangFormat: 'clang-format',
    parallel: 4,
    outputLimitBytes: 64 * 1024,
    displayLimitChars: 1000
}

describe.skipIf(process.platform !== 'win32')('Windows passthrough crash protection', () => {
    let dir: string, input: string, answer: string, crash: string, waiting: string
    async function build(name: string, source: string): Promise<string> {
        const result = await compileSource(path.join(dir, name + '.cpp'), source, tc, false)
        expect(result.ok, result.output).toBe(true)
        return result.exe!
    }
    async function guiParent(exe: string): Promise<string> {
        // Reset the immediate parent's mode to reproduce Electron's GUI environment.
        // The passthrough job must still protect its child; Node's default is insufficient.
        return build(
            'gui-parent',
            `#include <windows.h>
#include <process.h>
#include <vector>
int main(int argc,char** argv) {
    SetErrorMode(0);
    const char* program = ${JSON.stringify(exe)};
    std::vector<const char*> args{program};
    for(int i=1;i<argc;++i)args.push_back(argv[i]);
    args.push_back(nullptr);
    return _spawnv(_P_WAIT,program,args.data());
}`
        )
    }
    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-no-dialog-test-'))
        input = path.join(dir, 'case.in')
        answer = path.join(dir, 'case.ans')
        await fs.writeFile(input, '1')
        await fs.writeFile(answer, 'ok')
        crash = await guiParent(await build('crash', 'int main(){*static_cast<volatile int*>(nullptr)=1;}'))
        waiting = await build(
            'waiting',
            '#include <iostream>\n#include <thread>\n#include <chrono>\nint main(){int x=0; std::cin>>x; std::this_thread::sleep_for(std::chrono::seconds(5));}'
        )
    })
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    })

    it('returns RE promptly in the unmeasured fallback and after measuring-helper setup failure', async () => {
        const cfg = defaultProblem('fallback')
        const test = { id: 'case', name: 'case', enabled: true, link: { input: 'case.in', answer: 'case.ans' } }
        const unavailable = await build('unavailable-helper', 'int main(){return 125;}')
        const cached = testFilePaths(path.join(dir, 'main.cpp'), 'case')
        await fs.mkdir(path.dirname(cached.input), { recursive: true })
        await fs.copyFile(input, cached.input)
        await fs.copyFile(answer, cached.answer)
        for (const runner of [undefined, unavailable]) {
            const result = await runTest({
                src: path.join(dir, 'main.cpp'),
                exe: crash,
                cfg,
                test,
                runner,
                tc,
                signal: new AbortController().signal
            })
            expect(result, JSON.stringify(result)).toMatchObject({ verdict: 'RE', exitCode: 0xc0000005 })
            expect(result.memoryKb).toBeUndefined()
            expect(result.timeMs).toBeLessThan(1000)
        }
    }, 40_000)

    it('returns RE promptly when an interactive user program segfaults', async () => {
        const eofChecker = await build(
            'eof-checker',
            '#include <iostream>\nint main(){int x=0; return (std::cin>>x)?0:1;}'
        )
        for (const interactor of [waiting, eofChecker]) {
            const result = await runInteractive({
                exe: crash,
                interactor,
                scratch: dir,
                testId: 'case',
                input,
                answer,
                output: path.join(dir, 'out'),
                timeLimit: 1000,
                tc,
                signal: new AbortController().signal
            })
            expect(result, JSON.stringify(result)).toMatchObject({ verdict: 'RE', exitCode: 0xc0000005 })
            expect(result.timeMs).toBeLessThan(1000)
        }
    }, 40_000)

    it('reports a crashing interactor as SE without waiting for its timeout', async () => {
        const start = performance.now()
        const result = await runInteractive({
            exe: waiting,
            interactor: crash,
            scratch: dir,
            testId: 'case',
            input,
            answer,
            output: path.join(dir, 'out'),
            timeLimit: 1000,
            tc,
            signal: new AbortController().signal
        })
        expect(result, JSON.stringify(result)).toMatchObject({
            verdict: 'SE',
            checkerMessage: expect.stringContaining('3221225477')
        })
        expect(performance.now() - start).toBeLessThan(1500)
    }, 40_000)

    it('reports a crashing custom checker without waiting for the 10-second guard', async () => {
        const start = performance.now()
        const result = await customCheck(
            crash,
            { kind: 'custom' },
            { input, answer, output: path.join(dir, 'out'), score: path.join(dir, 'score') },
            tc,
            new AbortController().signal
        )
        expect(result).toMatchObject({ verdict: 'SE', checkerMessage: expect.stringContaining('3221225477') })
        expect(performance.now() - start).toBeLessThan(1000)
    }, 40_000)
})
