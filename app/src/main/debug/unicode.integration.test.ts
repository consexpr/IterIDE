import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DebugEvent, DebugStartRequest, DebugState } from '../../shared/debug'
import type { ToolchainSettings } from '../../shared/judge'
import { defaultSettings } from '../../shared/settings'
import type { JudgeEngine } from '../judge/engine'
import { loadProblem, saveProblem } from '../problem/store'
import { configureToolchain } from '../toolchain'
import { DebugManager } from './manager'

const root = process.env.ITER_TEST_UNICODE_TOOLCHAIN
describe.skipIf(process.platform !== 'win32' || !root)('real GDB in a Unicode installation', () => {
    let scratch: string,
        tempRoot: string,
        sourcePath: string,
        manager: DebugManager,
        events: DebugEvent[],
        state: DebugState
    beforeEach(async () => {
        tempRoot = path.resolve(os.tmpdir())
        scratch = await fs.mkdtemp(path.join(tempRoot, 'iter-gdb-unicode-'))
        const work = path.join(scratch, '题目 空格'),
            temp = path.join(scratch, '临时 空格')
        await Promise.all([fs.mkdir(work), fs.mkdir(temp)])
        sourcePath = path.join(work, 'main.cpp')
        vi.stubEnv('TEMP', temp)
        vi.stubEnv('TMP', temp)
        vi.stubEnv('ITER_STORE', path.join(scratch, 'store'))
        configureToolchain(root!)
        const tools: ToolchainSettings = {
            ...defaultSettings().toolchain,
            ...(process.env.ITER_TEST_GDB_EXECUTABLE ? { gdb: process.env.ITER_TEST_GDB_EXECUTABLE } : {})
        }
        events = []
        state = { status: 'idle' }
        manager = new DebugManager(
            {} as JudgeEngine,
            () => tools,
            (event) => {
                events.push(event)
                if (event.type === 'state') state = event.state
            }
        )
    })
    afterEach(async () => {
        await manager?.dispose()
        configureToolchain(path.resolve('resources/toolchain'))
        vi.unstubAllEnvs()
        const target = path.resolve(scratch)
        if (path.dirname(target) !== tempRoot || !path.basename(target).startsWith('iter-gdb-unicode-'))
            throw new Error('Unsafe debug test cleanup path')
        await fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
    })
    async function start(source: string, request: Partial<DebugStartRequest> = {}) {
        await fs.writeFile(sourcePath, source)
        await manager.start({ sourcePath, source, input: '7\n', stopAtEntry: true, breakpoints: [], ...request })
        expect(state, JSON.stringify(state)).not.toHaveProperty('status', 'error')
    }
    async function finished() {
        await vi.waitFor(
            () =>
                expect(
                    events.some((event) => event.type === 'recording' && event.done),
                    JSON.stringify(state)
                ).toBe(true),
            { timeout: 20_000 }
        )
        expect(state, JSON.stringify(state)).not.toHaveProperty('status', 'error')
    }

    it('keeps stdin, stdout, Unicode source breakpoints, pretty printers and exact queries working', async () => {
        const source =
            '#include <iostream>\n#include <vector>\nint main(){\n int input=0;\n std::cin >> input;\n std::vector<int> values{input,input+1};\n int total=values[0]+values[1];\n std::cout << total << "\\n";\n return 0;\n}\n'
        await start(source, { stopAtEntry: false, breakpoints: [{ line: 7, enabled: true }] })
        expect(state).toMatchObject({ status: 'paused', reason: 'breakpoint', file: sourcePath, line: 7 })
        expect((await manager.breakpoints())[0]).toMatchObject({ verified: true, line: 7 })
        const values = (await manager.locals()).find((variable) => variable.name === 'values')!
        expect((await manager.children(values.ref!)).map((value) => value.value)).toEqual(['7', '8'])
        expect(await manager.evaluate('static_cast<int>(values[1])')).toMatchObject({ value: '8' })
        await finished()
        await manager.command('continue')
        expect(state).toMatchObject({ status: 'exited', exitCode: 0, stdout: '15\n' })
        await manager.command('restart')
        expect(state).toMatchObject({ status: 'paused', reason: 'breakpoint', file: sourcePath, line: 7 })
    }, 30_000)

    it('continues the live tail after a short recording and preserves redirected output', async () => {
        await start(
            '#include <iostream>\nint main(){\n int input=0;\n std::cin >> input;\n std::cout << input+2 << "\\n";\n return 0;\n}\n',
            { recording: { maxSteps: 1 } }
        )
        await finished()
        expect(state).toMatchObject({ status: 'paused', mode: 'live', recordingEnded: false })
        await manager.command('continue')
        expect(state).toMatchObject({ status: 'exited', exitCode: 0, stdout: '9\n' })
    }, 30_000)

    it('retains file IO inside the Unicode run directory', async () => {
        const problem = await loadProblem(sourcePath)
        problem.fileIO = { enabled: true, input: 'case.in', output: 'case.out' }
        await saveProblem(sourcePath, problem)
        await start(
            '#include <cstdio>\nint main(){\n freopen("case.in","rb",stdin);\n freopen("case.out","wb",stdout);\n int input=0;\n scanf("%d",&input);\n printf("%d\\n",input+3);\n return 0;\n}\n'
        )
        await finished()
        await manager.command('continue')
        expect(state).toMatchObject({ status: 'exited', exitCode: 0, stdout: '10\n' })
    }, 30_000)
})
