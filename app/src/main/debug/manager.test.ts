import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { performance } from 'node:perf_hooks'
import { DebugManager } from './manager'
import { buildDebug, removeBuild } from './build'
import { NativeDebugger } from './native'
import { loadProblem, saveProblem } from '../problem/store'
import type { JudgeEngine } from '../judge/engine'
import type { ToolchainSettings } from '../../shared/judge'
import type { DebugEvent, DebugStartRequest, DebugState } from '../../shared/debug'

const tools: ToolchainSettings = {
    compiler: 'g++',
    gdb: 'gdb',
    flags: '-std=c++17',
    debugFlags: '-std=c++17 -g -O0',
    clangd: 'clangd',
    clangFormat: 'clang-format',
    parallel: 1,
    outputLimitBytes: 1e6,
    displayLimitChars: 1e6
}
let dir: string, sourcePath: string, manager: DebugManager, events: DebugEvent[], state: DebugState, firstStopAt: number
beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-debug-test-'))
    vi.stubEnv('ITER_STORE', path.join(dir, 'store'))
    sourcePath = path.join(dir, 'main.cpp')
    events = []
    state = { status: 'idle' }
    firstStopAt = 0
    manager = new DebugManager(
        {} as JudgeEngine,
        () => tools,
        (e) => {
            events.push(e)
            if (e.type === 'state') {
                state = e.state
                if (state.status === 'paused' && !firstStopAt) firstStopAt = performance.now()
            }
        }
    )
})
afterEach(async () => {
    await manager.command('stop')
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
async function start(source: string, extra: Partial<DebugStartRequest> = {}): Promise<void> {
    await startProgressive(source, extra)
    await completed()
    expect(state.status).toBe('paused')
}
async function startProgressive(source: string, extra: Partial<DebugStartRequest> = {}): Promise<void> {
    await fs.writeFile(sourcePath, source)
    await manager.start({ sourcePath, source, input: '', breakpoints: [], stopAtEntry: true, ...extra })
    if (state.status === 'error') throw new Error(state.message)
}
async function completed(): Promise<void> {
    for (const until = performance.now() + 190_000; !events.some((e) => e.type === 'recording' && e.done); ) {
        if (state.status === 'error') throw new Error(state.message)
        if (performance.now() > until) throw new Error('Recording did not complete')
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
    if (state.status === 'error') throw new Error(state.message)
}
function paused() {
    if (state.status !== 'paused') throw new Error(JSON.stringify(state))
    return state
}

describe('record then replay with real GDB', () => {
    it('starts recording at the first matching breakpoint after preprocessing without spending its budget', async () => {
        await start(
            '#include <thread>\n#include <chrono>\nint main(){\n volatile int sum=0;\n for(int i=0;i<100000;i++)sum+=i;\n std::this_thread::sleep_for(std::chrono::milliseconds(700));\n int answer=sum;\n answer++;\n return 0;\n}\n',
            {
                stopAtEntry: false,
                breakpoints: [{ line: 7, enabled: true }],
                recording: { maxSteps: 2, maxDurationMs: 500 }
            }
        )
        expect(paused()).toMatchObject({
            reason: 'breakpoint',
            line: 7,
            stepIndex: 0,
            totalSteps: 2,
            recordingLimit: 'steps',
            canStepBack: false
        })
        await manager.command('stepOver')
        expect(paused().line).toBe(8)
        await manager.command('continue')
        expect(state).toMatchObject({ status: 'exited', exitCode: 0, mode: 'live' })
    }, 20_000)

    it('retains pre-recording hit counts and the conditional starting point for exact queries', async () => {
        await start('int main(){\n int a[8]={0};\n for(int i=0;i<6;i++){\n  a[i]=i+10;\n }\n return 0;\n}\n', {
            stopAtEntry: false,
            breakpoints: [{ line: 4, enabled: true, condition: 'i>=2', hitCondition: 2 }],
            recording: { maxChildren: 1 }
        })
        expect(paused()).toMatchObject({ reason: 'breakpoint', line: 4, stepIndex: 0 })
        expect((await manager.breakpoints())[0].hits).toBe(2)
        expect((await manager.evaluate('i'))?.value).toBe('3')
        expect((await manager.evaluate('a[2]'))?.value).toBe('12')
        await manager.command('continue')
        expect((await manager.evaluate('i'))?.value).toBe('4')
        expect((await manager.breakpoints())[0].hits).toBe(3)
    }, 20_000)

    it('keeps the live inferior after a time cap, exact inspection, and backward browsing', async () => {
        const record = NativeDebugger.prototype.record
        let native!: NativeDebugger
        vi.spyOn(NativeDebugger.prototype, 'record').mockImplementation(function (this: NativeDebugger, ...args) {
            native = this
            return record.apply(this, args)
        })
        await start(
            'int main(){\n int a[8]={0,1,2,3,4,5,6,7};\n volatile unsigned x=0;\n for(unsigned i=0;i<100000;i++){\n  x++;\n }\n x++;\n return 0;\n}\n',
            { recording: { maxDurationMs: 700, maxChildren: 1 }, breakpoints: [{ line: 7, enabled: true }] }
        )
        expect(paused()).toMatchObject({ mode: 'live', recordingLimit: 'time', recordingEnded: false })
        const pids = native.client.inferiorPids
        const frontier = paused().totalSteps - 1
        await manager.seek(frontier)
        await manager.command('stepBack')
        expect((await manager.evaluate('a[5]'))?.value).toBe('5')
        expect(native.client.inferiorPids).toEqual(pids)
        await manager.command('continue')
        expect(paused()).toMatchObject({ line: 7, mode: 'live', recordingEnded: false })
        expect(native.client.inferiorPids).toEqual(pids)
        await manager.command('continue')
        expect(state).toMatchObject({ status: 'exited', exitCode: 0 })
    }, 20_000)

    it('publishes an early conditional breakpoint, waits for future seeks and continues, and restarts with the right reason', async () => {
        await startProgressive(
            'int main(){\n int s=0;\n for(int i=0;i<1500;i++){\n  s+=i;\n }\n return s==1124250?0:1;\n}\n',
            {
                stopAtEntry: false,
                breakpoints: [
                    { line: 4, enabled: true, condition: 'i == 2' },
                    { line: 6, enabled: true }
                ]
            }
        )
        expect(paused()).toMatchObject({ reason: 'breakpoint', line: 4, recordingComplete: false })
        expect((await manager.evaluate('i'))?.value).toBe('2')
        expect(paused().totalSteps).toBeLessThan(1000)
        await manager.seek(1000)
        expect(paused().stepIndex).toBe(1000)
        expect(paused().recordingComplete).toBe(false)
        await manager.command('continue')
        expect(paused()).toMatchObject({ reason: 'breakpoint', line: 6 })
        await completed()
        await manager.command('restart')
        expect(paused()).toMatchObject({ reason: 'breakpoint', line: 4 })
        expect((await manager.evaluate('i'))?.value).toBe('2')
        const progress = events.filter((e) => e.type === 'recording' && !e.done && e.steps > 0)
        expect(progress.length).toBeGreaterThan(1)
        expect(progress.length).toBeLessThan(100)
    }, 60_000)
    it('cancels pending frontier searches when a newer command wins, and cancels recording on restart/stop', async () => {
        await startProgressive('int main(){\n int s=0;\n for(int i=0;i<5000;i++){\n  s+=i;\n }\n return 0;\n}\n')
        expect(paused().recordingComplete).toBe(false)
        const seek = manager.seek(100_000)
        await manager.command('stepIn')
        await seek
        expect(paused().stepIndex).toBe(1)
        const out = manager.command('stepOut')
        await manager.seek(0)
        await out
        const cursor = manager.runToCursor(sourcePath, 6)
        await manager.command('stepBack')
        await cursor
        expect(paused().stepIndex).toBe(0)
        const continuing = manager.command('continue')
        await manager.command('restart')
        await continuing
        expect(paused()).toMatchObject({ reason: 'entry', stepIndex: 0, recordingComplete: false })
        const waiting = manager.seek(100_000)
        await manager.command('stop')
        await waiting
        expect(state.status).toBe('idle')
        const count = events.length
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(events.length).toBe(count)
    }, 60_000)
    it('waits for recording limits before rejecting an out-of-range seek, and keeps the live frontier usable', async () => {
        await startProgressive('int main(){\n unsigned s=0;\n for(int i=0;i<10000;i++){\n  s++;\n }\n return 0;\n}\n', {
            recording: { maxSteps: 800 }
        })
        expect(paused().recordingComplete).toBe(false)
        await expect(manager.seek(900)).rejects.toThrow('超出记录范围')
        expect(paused()).toMatchObject({ mode: 'live', recordingComplete: true, totalSteps: 800 })
        await manager.seek(799)
        await manager.command('stepIn')
        expect(paused().stepIndex).toBe(800)
    }, 60_000)
    it('uses an isolated exact seeker for truncated values and conditions while recording continues', async () => {
        await startProgressive(
            '#include <vector>\nint g=7;\nint main(){\n std::vector<int>a(20,7);\n int s=0;\n for(int i=0;i<3000;i++){\n  s+=i;\n }\n return 0;\n}\n',
            {
                stopAtEntry: false,
                breakpoints: [{ line: 5, enabled: true, condition: '(int)a[9] == g' }],
                recording: { maxChildren: 2 }
            }
        )
        expect(paused()).toMatchObject({ reason: 'breakpoint', line: 5, recordingComplete: false })
        expect((await manager.breakpoints())[0]).toMatchObject({ verified: true, hits: 1 })
        expect((await manager.evaluate('a[9]'))?.value).toBe('7')
        expect((await manager.evaluate('g+1'))?.value).toBe('8')
        expect(paused().recordingComplete).toBe(false)
        const a = (await manager.locals()).find((v) => v.name === 'a')!
        expect((await manager.children(a.ref!)).map((v) => v.value)).toEqual(['7', '7'])
        await manager.seek(0)
        expect(events.filter((e) => e.type === 'output').at(-1)).toMatchObject({ stdout: '', stderr: '' })
    }, 60_000)
    it('retains user-header callbacks with direct symbol discovery', async () => {
        const header = path.join(dir, 'compare.h')
        await fs.writeFile(
            header,
            '#pragma once\nnamespace local {\nstruct Less { bool operator()(int a,int b)const {\n return a<b;\n} };\n}\n'
        )
        await start(
            '#include <algorithm>\n#include "compare.h"\nint main(){\n int a[]={3,1,2};\n std::sort(a,a+3,local::Less{});\n return a[0]==1?0:1;\n}\n'
        )
        await manager.runToCursor(header, 4)
        expect(paused()).toMatchObject({ file: header, line: 4, reason: 'cursor' })
        expect((await manager.stack())[0].func).toContain('local::Less::operator()')
        await manager.command('stepOut')
        expect((await manager.stack())[0].func).toBe('main')
    }, 60_000)
    it('records a loop, looks up values, rewinds output and seeks', async () => {
        await start(
            '#include <cstdio>\nint main() {\n int sum=0;\n for(int i=0;i<3;i++) {\n  sum+=i;\n  printf("%d\\n",sum);\n }\n return 0;\n}\n'
        )
        expect(paused().mode).toBe('replay')
        expect(paused().recordingEnded).toBe(true)
        await manager.command('next')
        expect(paused().line).toBe(4)
        await manager.runToCursor(sourcePath, 6)
        expect(paused().line).toBe(6)
        expect((await manager.evaluate('sum'))?.value).toBe('0')
        await manager.command('stepIn')
        const index = paused().stepIndex
        await manager.command('stepBack')
        expect(paused().stepIndex).toBe(index - 1)
        await manager.seek(0)
        expect(events.filter((e) => e.type === 'output').at(-1)).toMatchObject({ stdout: '', stderr: '' })
        await manager.command('continue')
        expect(state).toMatchObject({ status: 'exited', exitCode: 0, stdout: '0\n1\n3\n' })
    }, 60_000)
    it('matches native GDB step/next/finish through functions and recursion', async () => {
        const source =
            'int f(int n) {\n if(n<=1) return n;\n int a=f(n-1);\n return a+1;\n}\nint main() {\n int x=4;\n int y=f(x);\n return y==4 ? 0:1;\n}\n'
        await start(source)
        const build = await buildDebug(
            { sourcePath, source, input: '', breakpoints: [] },
            tools,
            new AbortController().signal
        )
        const native = new NativeDebugger(
            build,
            tools,
            { maxSteps: 1 },
            () => {},
            (error) => {
                throw error
            }
        )
        try {
            await native.initialize(source)
            await native.record()
            const commands = [
                'stepOver',
                'stepIn',
                'stepIn',
                'stepIn',
                'stepIn',
                'stepOut',
                'stepOver',
                'stepOut'
            ] as const
            for (const [i, command] of commands.entries()) {
                const expected = await native.advance(
                    i + 1,
                    command === 'stepOver' ? 'next' : command === 'stepOut' ? 'finish' : 'step',
                    []
                )
                await manager.command(command)
                expect(paused().line, command).toBe(expected.line)
                expect(
                    (await manager.stack()).map((f) => f.func),
                    command
                ).toEqual(expected.frames.map((f) => f.func))
            }
            const stack = await manager.stack()
            if (stack[1]?.func === 'main') {
                await manager.selectFrame(1)
                expect((await manager.locals()).some((v) => v.name === 'x')).toBe(true)
                expect(paused().frame).toBe(1)
            }
        } finally {
            await native.dispose()
            await removeBuild(build.dir)
        }
    }, 60_000)
    it('captures globals, vectors, nested arrays and exactly seeks truncated data', async () => {
        await start(
            '#include <vector>\nint g[2][3]={{1,2,3},{4,5,6}};\nint main() {\n std::vector<int> a(8);\n for(int i=0;i<8;i++) a[i]=i*7;\n int sum=a[7]+g[1][2];\n return sum==55?0:1;\n}\n',
            { recording: { maxChildren: 2, maxDepth: 1 } }
        )
        await manager.runToCursor(sourcePath, 7)
        const locals = await manager.locals()
        const a = locals.find((v) => v.name === 'a')!
        expect(a.truncated).toBe(true)
        expect(locals.find((v) => v.name === '::g')?.scope).toBe('global')
        expect((await manager.children(a.ref!)).map((v) => v.value)).toEqual(['0', '7'])
        expect((await manager.evaluate('a[7]'))?.value).toBe('49')
        expect((await manager.evaluate('g[1][2]'))?.value).toBe('6')
        expect((await manager.evaluate('a[7]+g[1][2]'))?.value).toBe('55')
        const index = paused().stepIndex
        await manager.command('stepBack')
        await manager.seek(index)
        expect((await manager.evaluate('a[7]'))?.value).toBe('49')
        expect(paused().stepIndex).toBe(index)
    }, 60_000)
    it('evaluates breakpoint conditions and hit conditions against each visit', async () => {
        await start('int main(){\n int sum=0;\n for(int i=0;i<5;i++){\n  sum+=i;\n }\n return 0;\n}\n')
        await manager.setBreakpoints(sourcePath, [
            { line: 4, enabled: true, condition: 'i >= 1 && i < 4', hitCondition: 2 }
        ])
        await manager.command('continue')
        expect(paused()).toMatchObject({ reason: 'breakpoint', line: 4 })
        expect((await manager.evaluate('i'))?.value).toBe('2')
        expect((await manager.breakpoints())[0]).toMatchObject({ verified: true, hits: 2 })
        await manager.command('stepBack')
        expect((await manager.breakpoints())[0].hits).toBe(1)
        await manager.setBreakpoints(sourcePath, [{ line: 2, enabled: true, condition: 'missing == 2' }])
        expect((await manager.breakpoints())[0]).toMatchObject({
            verified: false,
            error: expect.stringContaining('断点条件无效')
        })
        expect(state.status).toBe('paused')
        await manager.setBreakpoints(sourcePath, [{ line: 4, enabled: true, hitCondition: -1 }])
        expect((await manager.breakpoints())[0].verified).toBe(false)
    }, 60_000)
    it('records cin input, skips STL and preserves a final crash snapshot', async () => {
        await start(
            '#include <iostream>\n#include <vector>\nint add(int x,int y){\n return x+y;\n}\nint main(){\n int n; std::cin>>n;\n std::vector<int> a(n,2);\n int x=add(1,a[0]);\n std::cout<<x<<std::endl;\n int *p=nullptr;\n *p=4;\n return 0;\n}\n',
            { input: '3\n' }
        )
        expect(paused().final?.signal).toBe('SIGSEGV')
        await manager.runToCursor(sourcePath, 9)
        await manager.command('stepIn')
        expect((await manager.stack())[0].func).toBe('add')
        expect(paused().line).toBe(4)
        await manager.command('continue')
        expect(paused()).toMatchObject({ reason: 'signal', signal: 'SIGSEGV', line: 12, recordingEnded: true })
        expect(events.filter((e) => e.type === 'output').at(-1)).toMatchObject({ stdout: '3\n' })
    }, 60_000)
    it('continues live from a step cap and retains instant access to its prefix', async () => {
        await start('int main(){\n int s=0;\n for(int i=0;i<8;i++){\n  s+=i;\n }\n return s==28?0:1;\n}\n', {
            stopAtEntry: false,
            recording: { maxSteps: 4 }
        })
        expect(paused()).toMatchObject({
            mode: 'live',
            totalSteps: 4,
            stepIndex: 0,
            reason: 'entry',
            recordingEnded: false
        })
        expect(events).toContainEqual(expect.objectContaining({ type: 'recording', done: true, limited: 'steps' }))
        await manager.seek(3)
        await manager.command('stepOver')
        expect(paused().stepIndex).toBe(4)
        await manager.command('stepBack')
        expect(paused().stepIndex).toBe(3)
        await manager.seek(4)
        await manager.command('continue')
        expect(state, JSON.stringify(state)).toMatchObject({ status: 'exited', exitCode: 0, mode: 'live' })
        await manager.seek(0)
        expect(paused().stepIndex).toBe(0)
    }, 60_000)
    it('caps recording by time and pauses an infinite live tail without a fatal signal', async () => {
        await start('int main(){\n unsigned x=0;\n for(;;) x++;\n}\n', { recording: { maxDurationMs: 600 } })
        expect(paused().mode).toBe('live')
        expect(events).toContainEqual(expect.objectContaining({ type: 'recording', done: true, limited: 'time' }))
        await manager.seek(paused().totalSteps - 1)
        const moving = manager.command('continue')
        for (let i = 0; i < 200 && state.status !== 'running'; i++)
            await new Promise((resolve) => setTimeout(resolve, 10))
        expect(state.status).toBe('running')
        await manager.command('pause')
        await moving
        expect(paused()).toMatchObject({ reason: 'pause', recordingEnded: false })
    }, 60_000)
    it('interrupts a recording step blocked inside non-user code at the wall cap', async () => {
        const foreign = path.join(os.tmpdir(), 'iter-system-hang.cpp').replace(/\\/g, '/')
        const user = sourcePath.replace(/\\/g, '/')
        const begin = performance.now()
        await start(
            `#line 1 "${foreign}"\nvoid hang(){for(;;){}}\n#line 1 "${user}"\nint main(){\n int x=1;\n hang();\n return x;\n}\n`,
            { recording: { maxDurationMs: 3000 } }
        )
        expect(paused()).toMatchObject({ mode: 'live', recordingEnded: false })
        expect(events).toContainEqual(expect.objectContaining({ type: 'recording', done: true, limited: 'time' }))
        await manager.seek(paused().totalSteps - 1)
        expect(paused().signal).toBeUndefined()
        expect((await manager.stack()).some((frame) => frame.func === 'hang')).toBe(true)
        expect(performance.now() - begin).toBeLessThan(10_000)
    }, 15_000)
    it('pauses a live next blocked inside non-user code without automatically resuming', async () => {
        const foreign = path.join(os.tmpdir(), 'iter-system-hang.cpp').replace(/\\/g, '/')
        const user = sourcePath.replace(/\\/g, '/')
        await start(
            `#line 1 "${foreign}"\nvoid hang(){for(;;){}}\n#line 1 "${user}"\nint main(){\n int x=1;\n hang();\n return x;\n}\n`,
            { recording: { maxSteps: 1 } }
        )
        await manager.command('stepOver')
        const moving = manager.command('stepOver')
        for (let i = 0; i < 200 && state.status !== 'running'; i++)
            await new Promise((resolve) => setTimeout(resolve, 10))
        expect(state.status).toBe('running')
        await manager.command('pause')
        await moving
        expect(paused()).toMatchObject({ reason: 'pause', recordingEnded: false })
    }, 15_000)
    it('selects an outer recursive frame and resets selection at the next stop', async () => {
        await start(
            'int fib(int n){\n if(n<2)return n;\n int a=fib(n-1);\n int b=fib(n-2);\n return a+b;\n}\nint main(){\n int result=fib(5);\n return result==5?0:1;\n}\n'
        )
        await manager.runToCursor(sourcePath, 2)
        expect((await manager.evaluate('n'))?.value).toBe('5')
        await manager.command('stepIn')
        await manager.command('stepIn')
        expect((await manager.evaluate('n'))?.value).toBe('4')
        await manager.selectFrame(1)
        expect((await manager.evaluate('n'))?.value).toBe('5')
        expect((await manager.locals()).find((v) => v.name === 'n')?.value).toBe('5')
        await manager.command('stepIn')
        expect(paused().frame).toBe(0)
        await manager.command('continue')
        expect(state).toMatchObject({ status: 'exited', exitCode: 0 })
    }, 60_000)
    it('keeps output exact across overwrites, UTF-8 text and rewinds', async () => {
        await start(
            '#include <cstdio>\nint main(){\n printf("abc");\n fseek(stdout,0,SEEK_SET);\n printf("Z");\n fprintf(stderr,"err");\n return 0;\n}\n'
        )
        await manager.runToCursor(sourcePath, 4)
        const before = paused().stepIndex
        expect(events.filter((e) => e.type === 'output').at(-1)).toMatchObject({ stdout: 'abc' })
        await manager.runToCursor(sourcePath, 6)
        expect(events.filter((e) => e.type === 'output').at(-1)).toMatchObject({ stdout: 'Zbc' })
        await manager.seek(before)
        expect(events.filter((e) => e.type === 'output').at(-1)).toMatchObject({ stdout: 'abc', stderr: '' })
        await manager.command('continue')
        expect(state).toMatchObject({ status: 'exited', stdout: 'Zbc', stderr: 'err' })
    }, 60_000)
    it('does not move breakpoints or the cursor onto an unexecuted branch', async () => {
        await start('int main(){\n int x=0;\n if(x){\n  x=99;\n }\n // no code\n x=1;\n return 0;\n}\n')
        await manager.setBreakpoints(sourcePath, [{ line: 4, enabled: true }])
        expect((await manager.breakpoints())[0]).toMatchObject({ line: 4, verified: true })
        await manager.runToCursor(sourcePath, 6)
        expect(paused().line).toBe(7)
        await manager.seek(0)
        await manager.runToCursor(sourcePath, 4)
        expect(state.status).toBe('exited')
    }, 60_000)
    it('preserves file IO and multi-source grader build hooks', async () => {
        await fs.writeFile(sourcePath, 'int solve(int x){\n return x*3;\n}\n')
        const grader = path.join(dir, 'grader.cpp')
        await fs.writeFile(
            grader,
            '#include<cstdio>\nint solve(int);\nint main(){\n freopen("in.txt","r",stdin);\n freopen("out.txt","w",stdout);\n int x;scanf("%d",&x);\n printf("%d\\n",solve(x));\n}\n'
        )
        const config = await loadProblem(sourcePath)
        config.mode = 'grader'
        config.grader = { sources: ['grader.cpp'] }
        config.fileIO = { enabled: true, input: 'in.txt', output: 'out.txt' }
        await saveProblem(sourcePath, config)
        await start('int solve(int x){\n return x*3;\n}\n', { input: '7\n' })
        await manager.runToCursor(sourcePath, 2)
        expect((await manager.evaluate('x'))?.value).toBe('7')
        await manager.command('continue')
        expect(state).toMatchObject({
            status: 'exited',
            exitCode: 0,
            stdout: process.platform === 'win32' ? '21\r\n' : '21\n'
        })
    }, 60_000)
    it('supports a Python-less GDB with bounded MI locals and children in live mode', async () => {
        // Exact queries start a second debugger; simulate the same unavailable
        // Python capability for both the live instance and its query process.
        const initialize = NativeDebugger.prototype.initialize
        vi.spyOn(NativeDebugger.prototype, 'initialize').mockImplementation(async function (
            this: NativeDebugger,
            source
        ) {
            await initialize.call(this, source)
            this.python = false
        })
        const source = 'int main(){\n int a[3]={4,5,6};\n int x=a[1];\n return x==5?0:1;\n}\n'
        await fs.writeFile(sourcePath, source)
        const build = await buildDebug(
            { sourcePath, source, input: '', breakpoints: [] },
            tools,
            new AbortController().signal
        )
        const fatal: Error[] = []
        const native = new NativeDebugger(
            build,
            tools,
            undefined,
            () => {},
            (error) => fatal.push(error)
        )
        try {
            await native.initialize(source)
            const result = await native.record()
            expect(result.limited).toBe('python-unavailable')
            await native.advance(1, 'next', [])
            const a = await native.query(1, 0, 'a')
            expect(a.children?.map((v) => v.value)).toEqual(['4', '5', '6'])
            expect(fatal).toEqual([])
        } finally {
            await native.dispose()
            await removeBuild(build.dir)
        }
    }, 60_000)
    it('seeks exactly after live next/finish movements and counts ignored live hits', async () => {
        await start(
            'int f(int n){\n int a[4]={n,n+1,n+2,n+3};\n if(n<1)return a[3];\n int r=f(n-1);\n return r+a[3];\n}\nint main(){\n int v=f(2);\n return v==12?0:1;\n}\n',
            { recording: { maxSteps: 1, maxChildren: 1 } }
        )
        await manager.command('stepIn')
        await manager.command('stepOver')
        await manager.command('stepOver')
        await manager.command('stepOver')
        expect(paused().line).toBe(5)
        expect((await manager.evaluate('a[3]'))?.value).toBe('5')
        await manager.command('continue')
        expect(state).toMatchObject({ status: 'exited', exitCode: 0 })
        await start('int main(){\n int sum=0;\n for(int i=0;i<5;i++){\n  sum+=i;\n }\n return 0;\n}\n', {
            recording: { maxSteps: 2 }
        })
        await manager.setBreakpoints(sourcePath, [
            { line: 4, enabled: true, condition: 'i>=1 && i<4', hitCondition: 2 }
        ])
        await manager.seek(paused().totalSteps - 1)
        await manager.command('continue')
        expect((await manager.evaluate('i'))?.value).toBe('2')
        expect((await manager.breakpoints())[0].hits).toBe(2)
        await manager.command('continue')
        expect((await manager.evaluate('i'))?.value).toBe('3')
        expect((await manager.breakpoints())[0].hits).toBe(3)
        await manager.command('restart')
        await manager.seek(paused().totalSteps - 1)
        await manager.command('stepOver')
        expect((await manager.evaluate('i'))?.value).toBe('0')
        expect((await manager.breakpoints())[0].hits).toBe(0)
    }, 60_000)
    it('evaluates a truncated vector with no compiled operator[] and refuses divergent seeks', async () => {
        await start(
            '#include<vector>\nint main(){\n std::vector<int>a{1,2,3,4,5,6};\n int n=a.size();\n return n==6?0:1;\n}\n',
            { recording: { maxChildren: 1 } }
        )
        await manager.runToCursor(sourcePath, 5)
        expect((await manager.evaluate('a[5]'))?.value).toBe('6')
        await start(
            '#include<chrono>\nint main(){\n long long stamp=std::chrono::high_resolution_clock::now().time_since_epoch().count();\n int a[3]={1,2,3};\n return (stamp&&a[0])?0:1;\n}\n',
            { recording: { maxChildren: 1 } }
        )
        await manager.runToCursor(sourcePath, 5)
        expect(await manager.evaluate('a[2]')).toBeNull()
        expect(paused().message).toContain('求值失败')
        expect(await manager.evaluate('a[2]')).toBeNull()
        expect(state.status).toBe('paused')
    }, 60_000)
    it('precomputes unsupported breakpoint conditions so seek and stepping never execute GDB', async () => {
        await start('int main(){\n int sum=0;\n for(int i=0;i<3;i++){\n  sum+=i;\n }\n return 0;\n}\n')
        const total = paused().totalSteps
        await manager.setBreakpoints(sourcePath, [{ line: 4, enabled: true, condition: '(int)i >= 1' }])
        const query = vi.spyOn(NativeDebugger.prototype, 'query')
        for (let i = 0; i < total - 1; i++) await manager.seek(i)
        await manager.command('stepBack')
        await manager.command('stepIn')
        expect(query).not.toHaveBeenCalled()
        expect((await manager.breakpoints())[0].hits).toBe(2)
    }, 60_000)
    it('records user callbacks inside skipped STL calls and preserves native next/finish targets', async () => {
        await start(
            '#include<algorithm>\nint comparisons=0;\nbool cmp(int a,int b){\n comparisons++;\n return a>b;\n}\nint main(){\n int a[4]={1,3,2,4};\n std::sort(a,a+4,cmp);\n return a[0]==4?0:1;\n}\n'
        )
        await manager.runToCursor(sourcePath, 9)
        const call = paused().stepIndex
        await manager.command('stepIn')
        expect((await manager.stack())[0].func).toBe('cmp')
        expect(paused().line).toBe(4)
        expect((await manager.evaluate('comparisons'))?.value).toBe('0')
        await manager.command('stepOut')
        expect((await manager.stack())[0].func).toBe('main')
        await manager.seek(call)
        await manager.command('stepOver')
        expect(paused().line).toBe(10)
        expect((await manager.evaluate('a[0]'))?.value).toBe('4')
    }, 60_000)
    it('measures A2-sized recording and lookup navigation', async () => {
        const record = NativeDebugger.prototype.record
        vi.spyOn(NativeDebugger.prototype, 'record').mockImplementation(async function (this: NativeDebugger, ...args) {
            const result = await record.apply(this, args)
            process.stdout.write(JSON.stringify({ phases: 'A2', ...this.timings, ...result.timings }) + '\n')
            return result
        })
        // Same program/line layout as sandbox/A2.cpp, without depending on a local file.
        const source =
            '#include <bits/stdc++.h>\nusing namespace std;\nusing ll = long long;\n\nll add(ll x, ll y) {\n    ll r = x + y;\n    return r;\n}\n\nint main() {\n    int n;\n    cin >> n;\n    vector<ll> a(n);\n    for (auto &x : a) cin >> x;\n    ll sum = 0;\n    for (int i = 0; i < n; i++) sum = add(sum, a[i]);\n    cout << sum << "\\n";\n    return 0;\n}\n'
        const begin = performance.now()
        await start(source, { input: '3\n3 1 2\n', stopAtEntry: false, breakpoints: [{ line: 15, enabled: true }] })
        const initial = paused(),
            startMs = performance.now() - begin
        const times: number[] = []
        for (let i = 0; i < 100; i++) {
            const t = performance.now()
            await manager.seek(i % (initial.totalSteps - 1))
            times.push(performance.now() - t)
        }
        times.sort((a, b) => a - b)
        process.stdout.write(
            JSON.stringify({
                benchmark: 'A2-sized',
                steps: initial.totalSteps,
                recordingMs: initial.recordingMs,
                firstStopMs: firstStopAt - begin,
                buildAndStartMs: startMs,
                navigationMedianMs: times[50],
                navigationP95Ms: times[95]
            }) + '\n'
        )
        await manager.command('continue')
        expect(state).toMatchObject({ status: 'exited', stdout: '6\n' })
    }, 60_000)
    it('measures a complete 10k-step loop', async () => {
        const begin = performance.now()
        await start(
            'int main(){\n long long s=0;\n for(int i=0;i<5000;i++){\n  s+=i;\n }\n return s==12497500?0:1;\n}\n',
            {
                stopAtEntry: false,
                breakpoints: [{ line: 3, enabled: true }],
                recording: { maxSteps: 20_000, maxDurationMs: 180_000 }
            }
        )
        const initial = paused()
        const t = performance.now()
        await manager.seek(9000)
        process.stdout.write(
            JSON.stringify({
                benchmark: '10k-step loop',
                steps: initial.totalSteps,
                firstStopMs: firstStopAt - begin,
                recordingMs: initial.recordingMs,
                seek9000Ms: performance.now() - t
            }) + '\n'
        )
        expect(initial.mode).toBe('replay')
        expect(initial.totalSteps).toBeGreaterThanOrEqual(10_000)
        await manager.setBreakpoints(sourcePath, [])
        await manager.command('continue')
        expect(state).toMatchObject({ status: 'exited', exitCode: 0 })
    }, 200_000)
})
