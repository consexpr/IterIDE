import { expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DebugManager } from './manager'
import { NativeDebugger } from './native'
import type { JudgeEngine } from '../judge/engine'
import type { DebugState } from '../../shared/debug'
import type { ToolchainSettings } from '../../shared/judge'

it('handles held-F10 bursts before and after the recording frontier without interrupting its own step', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-held-step-'))
    vi.stubEnv('ITER_STORE', path.join(directory, 'store'))
    const tools: ToolchainSettings = {
        compiler: 'g++',
        gdb: 'gdb',
        flags: '-std=c++17',
        debugFlags: '-std=c++17 -g -O0',
        clangd: 'clangd',
        clangFormat: 'clang-format',
        parallel: 1,
        outputLimitBytes: 1024 * 1024,
        displayLimitChars: 1000
    }
    const source =
        '#include<thread>\n#include<chrono>\nint main(){\n int value=0;\n for(int i=0;i<6;i++){\n  std::this_thread::sleep_for(std::chrono::milliseconds(100));\n  value++;\n }\n return value==6?0:1;\n}\n'
    let state: DebugState = { status: 'idle' }
    const current = () => state
    const manager = new DebugManager(
        {} as JudgeEngine,
        () => tools,
        (event) => {
            if (event.type === 'state') state = event.state
        }
    )
    const interrupt = vi.spyOn(NativeDebugger.prototype, 'interrupt')
    const advance = vi.spyOn(NativeDebugger.prototype, 'advance')
    try {
        await manager.start({
            sourcePath: path.join(directory, 'main.cpp'),
            source,
            input: '',
            breakpoints: [],
            stopAtEntry: true,
            recording: { maxSteps: 3 }
        })
        await vi.waitFor(() =>
            expect(current()).toMatchObject({ recordingComplete: true, mode: 'live', recordingLimit: 'steps' })
        )
        await manager.seek(0)
        await Promise.all(Array.from({ length: 100 }, () => manager.command('stepOver')))
        expect(current()).toMatchObject({ status: 'paused', stepIndex: 1 })
        await manager.seek(2)
        expect(current()).toMatchObject({ line: 6 })
        const before = advance.mock.calls.length
        const moving = manager.command('stepOver')
        await vi.waitFor(() => expect(current()).toMatchObject({ status: 'running' }))
        const repeats = Array.from({ length: 100 }, () => manager.command('next'))
        await Promise.all([moving, ...repeats])
        expect(interrupt).not.toHaveBeenCalled()
        expect(advance.mock.calls.length - before).toBe(1)
        expect(current()).toMatchObject({ status: 'paused', stepIndex: 3, line: 7 })
        await manager.command('stepBack')
        expect(current()).toMatchObject({ status: 'paused', stepIndex: 2, line: 6 })
        await manager.command('continue')
        expect(current()).toMatchObject({ status: 'exited', exitCode: 0, recordingLimit: 'steps' })
        await manager.seek(0)
        expect(current()).toMatchObject({ status: 'paused', stepIndex: 0 })
    } finally {
        await manager.dispose()
        vi.restoreAllMocks()
        vi.unstubAllEnvs()
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
}, 30_000)
