import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DebugManager } from './manager'
import type { DebugEvent, DebugResourceLimit, DebugState } from '../../shared/debug'
import type { ToolchainSettings } from '../../shared/judge'
import type { JudgeEngine } from '../judge/engine'
const tools: ToolchainSettings = {
    compiler: 'g++',
    gdb: 'gdb',
    flags: '-std=c++17',
    debugFlags: '-g -O0',
    clangd: 'clangd',
    clangFormat: 'clang-format',
    parallel: 1,
    outputLimitBytes: 1024,
    displayLimitChars: 64
}
let dir: string, manager: DebugManager, events: DebugEvent[], state: DebugState
beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-budget-integration-'))
    vi.stubEnv('ITER_STORE', path.join(dir, 'store'))
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
    await manager.dispose()
    vi.unstubAllEnvs()
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})
async function waitForLimit(limit: DebugResourceLimit): Promise<void> {
    await vi.waitFor(
        () => {
            expect(state).toMatchObject({
                status: 'paused',
                resourceLimit: limit,
                recordingEnded: true,
                mode: 'replay'
            })
        },
        { timeout: 15_000 }
    )
    await manager.seek(0)
    expect(state).toMatchObject({ status: 'paused', stepIndex: 0, resourceLimit: limit })
    expect((await manager.stack()).length).toBeGreaterThan(0)
}
const noisy =
    '#include <cstdio>\nint main(){\n int value=0;\n for(int i=0;i<30;i++){\n puts("' +
    'x'.repeat(100) +
    '");\n value+=i;\n }\n for(;;){}\n return value;\n}'
it('stops excessive recording output and retains earlier snapshots', async () => {
    await manager.start({
        sourcePath: path.join(dir, 'main.cpp'),
        source: noisy,
        input: '',
        breakpoints: [],
        stopAtEntry: true
    })
    await waitForLimit('output')
    expect(
        events
            .filter((event) => event.type === 'output')
            .every((event) => event.stdout.length <= tools.displayLimitChars)
    ).toBe(true)
}, 30_000)
it('enforces the same output budget in the manually advanced live tail', async () => {
    await manager.start({
        sourcePath: path.join(dir, 'main.cpp'),
        source: noisy,
        input: '',
        breakpoints: [],
        stopAtEntry: true,
        recording: { maxSteps: 1 }
    })
    await vi.waitFor(() => expect(state).toMatchObject({ status: 'paused', recordingComplete: true, mode: 'live' }))
    await manager.command('continue')
    await waitForLimit('output')
}, 30_000)
it('enforces cumulative trace bytes while keeping the accepted prefix browseable', async () => {
    await manager.start({
        sourcePath: path.join(dir, 'main.cpp'),
        source: 'int main(){\n int value=0;\n for(int i=0;i<100;i++){\n value+=i;\n }\n return value;\n}',
        input: '',
        breakpoints: [],
        stopAtEntry: true,
        recording: { maxTraceBytes: 4096 }
    })
    await waitForLimit('trace')
}, 30_000)
it('enforces cumulative unique value nodes across snapshots', async () => {
    await manager.start({
        sourcePath: path.join(dir, 'main.cpp'),
        source: 'int main(){\n int value=0;\n for(int i=0;i<100;i++){\n value+=i;\n }\n return value;\n}',
        input: '',
        breakpoints: [],
        stopAtEntry: true,
        recording: { maxTotalNodes: 8 }
    })
    await waitForLimit('nodes')
}, 30_000)
