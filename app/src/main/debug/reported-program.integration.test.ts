import { expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { DebugManager } from './manager'
import type { JudgeEngine } from '../judge/engine'
import type { ToolchainSettings } from '../../shared/judge'
import type { DebugEvent, DebugState } from '../../shared/debug'

it('hits the reported main breakpoint and finishes the large-global program within the default recording budget', async () => {
    const source = await fs.readFile(new URL('./fixtures/reported-segment-tree.cpp', import.meta.url), 'utf8')
    const input = await fs.readFile(new URL('./fixtures/reported-segment-tree.in', import.meta.url), 'utf8')
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-reported-debug-'))
    vi.stubEnv('ITER_STORE', path.join(directory, 'store'))
    const sourcePath = path.join(directory, 'report.cpp')
    await fs.writeFile(sourcePath, source)
    const line = source.split(/\r?\n/).findIndex((text) => text.includes('cin>>T;while(T--) solve();')) + 1
    const tools: ToolchainSettings = {
        compiler: 'g++',
        gdb: 'gdb',
        flags: '-std=c++17',
        debugFlags: '-std=c++17 -g -O0',
        clangd: 'clangd',
        clangFormat: 'clang-format',
        parallel: 1,
        outputLimitBytes: 64 * 1024 * 1024,
        displayLimitChars: 200000
    }
    let state: DebugState = { status: 'idle' }
    const events: DebugEvent[] = []
    const manager = new DebugManager(
        {} as JudgeEngine,
        () => tools,
        (event) => {
            events.push(event)
            if (event.type === 'state') state = event.state
        }
    )
    const current = (): DebugState => state
    try {
        await manager.start({ sourcePath, source, input, stopAtEntry: false, breakpoints: [{ line, enabled: true }] })
        expect(current()).toMatchObject({ status: 'paused', reason: 'breakpoint', line, stepIndex: 0 })
        const deadline = performance.now() + 40_000
        while (!events.some((event) => event.type === 'recording' && event.done)) {
            if (current().status === 'error') throw Error(JSON.stringify(current()))
            if (performance.now() > deadline) throw Error('Reported program recording did not complete')
            await new Promise((resolve) => setTimeout(resolve, 20))
        }
        const done = events.filter((event) => event.type === 'recording' && event.done).at(-1)
        console.info('reported segment-tree recording', JSON.stringify(done))
        expect(done).toMatchObject({ done: true })
        expect(done?.type === 'recording' ? done.limited : 'missing').toBeUndefined()
        expect(current()).toMatchObject({
            status: 'paused',
            reason: 'breakpoint',
            line,
            stepIndex: 0,
            recordingComplete: true,
            recordingEnded: true
        })
        expect((await manager.breakpoints())[0]).toMatchObject({ line, enabled: true, verified: true })
        for (let attempts = 0; current().status !== 'exited' && attempts < 10; attempts++) {
            await manager.command('continue')
            if (current().status === 'paused') expect(current()).toMatchObject({ reason: 'breakpoint', line })
        }
        expect(current()).toMatchObject({
            status: 'exited',
            exitCode: 0,
            recordingComplete: true,
            recordingEnded: true
        })
    } finally {
        await manager.dispose()
        vi.unstubAllEnvs()
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
}, 60_000)
