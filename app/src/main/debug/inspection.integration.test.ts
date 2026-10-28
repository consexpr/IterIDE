import { afterEach, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildDebug, removeBuild, type DebugBuild } from './build'
import { NativeDebugger } from './native'
import type { ToolchainSettings } from '../../shared/judge'

const tools: ToolchainSettings = {
    compiler: 'g++',
    gdb: 'gdb',
    flags: '-std=c++17',
    debugFlags: '-std=c++17 -g -O0',
    clangd: 'clangd',
    clangFormat: 'clang-format',
    parallel: 1,
    outputLimitBytes: 1_000_000,
    displayLimitChars: 200_000
}
let directory: string | undefined, build: DebugBuild | undefined, debug: NativeDebugger | undefined
afterEach(async () => {
    await debug?.dispose()
    if (build) await removeBuild(build.dir)
    if (directory) await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    debug = undefined
    build = undefined
    directory = undefined
})

it('blocks overloaded operator calls in automatic inspections while keeping explicit evaluation available', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-inspect-'))
    const source =
        'struct Box {\n int hits=0;\n __attribute__((noinline)) int operator[](int i){++hits;return i+hits;}\n};\nint main(){\n Box box;\n int value=box[0];\n return value==1?0:1;\n}\n'
    build = await buildDebug(
        { sourcePath: path.join(directory, 'main.cpp'), source, breakpoints: [] },
        tools,
        new AbortController().signal
    )
    const errors: Error[] = []
    debug = new NativeDebugger(
        build,
        tools,
        undefined,
        () => {},
        (error) => errors.push(error)
    )
    await debug.initialize(source)
    const recording = await debug.record()
    const snapshot = recording.snapshots.find((s) => s.line === 7 && s.frames[0]?.func === 'main')!
    expect(snapshot).toBeDefined()
    const protectedResult = await Promise.allSettled([debug.query(snapshot.index, 0, 'box[0]', [], true)])
    expect(protectedResult[0]).toMatchObject({
        status: 'rejected',
        reason: expect.objectContaining({ message: expect.stringMatching(/may-call-functions|function|函数/i) })
    })
    expect((await debug.client.command('-gdb-show may-call-functions')).value).toBe('on')
    expect((await debug.query(snapshot.index, 0, 'box.hits', [], true)).value).toBe('0')
    expect((await debug.query(snapshot.index, 0, 'box[0]')).value).toBe('1')
    expect(errors).toEqual([])
}, 30_000)
