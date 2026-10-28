import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../../shared/settings'
import { buildDebug, removeBuild } from '../debug/build'
import { compileSource } from '../judge/compile'
import { execute } from '../judge/process'
import { configureToolchain } from './index'

// Use a physically copied Unicode installation, never a junction or a developer's live toolchain.
const root = process.env.ITER_TEST_UNICODE_TOOLCHAIN
describe.skipIf(process.platform !== 'win32' || !root)('real bundled compiler in a Unicode installation', () => {
    let scratch: string, tempRoot: string, sourcePath: string
    const source = '#include <iostream>\nint main(){std::cout << "OK";}\n'
    beforeEach(async () => {
        tempRoot = path.resolve(os.tmpdir())
        scratch = await fs.mkdtemp(path.join(tempRoot, 'iter-linker-real-'))
        const work = path.join(scratch, '题目 空格')
        await fs.mkdir(work)
        sourcePath = path.join(work, 'hello.cpp')
        await fs.writeFile(sourcePath, source)
        vi.stubEnv('ITER_STORE', path.join(scratch, 'store'))
        vi.stubEnv('TEMP', work)
        vi.stubEnv('TMP', work)
        configureToolchain(root!)
    })
    afterEach(async () => {
        configureToolchain(path.resolve('resources/toolchain'))
        vi.unstubAllEnvs()
        const target = path.resolve(scratch)
        if (path.dirname(target) !== tempRoot || !path.basename(target).startsWith('iter-linker-real-'))
            throw new Error('Unsafe linker test cleanup path')
        await fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
    })

    it('compiles and runs judge builds with Unicode source and TEMP paths', async () => {
        const result = await compileSource(sourcePath, source, defaultSettings().toolchain, false)
        expect(result.ok, result.output).toBe(true)
        expect(await execute(result.exe!, [], { timeout: 5000 })).toMatchObject({ code: 0, stdout: 'OK' })
    }, 30_000)

    it('builds and runs the debug program and its Windows interrupt helper', async () => {
        const result = await buildDebug(
            { sourcePath, source, input: '', breakpoints: [] },
            defaultSettings().toolchain,
            new AbortController().signal
        )
        try {
            expect(await execute(result.exe, [], { timeout: 5000 })).toMatchObject({ code: 0, stdout: 'OK' })
            expect(result.interruptExe).toBeTruthy()
            expect((await fs.stat(result.interruptExe!)).isFile()).toBe(true)
        } finally {
            await removeBuild(result.dir)
        }
    }, 30_000)

    it('returns a normal compile failure for unsupported GCC LTO instead of rejecting the operation', async () => {
        const tc = { ...defaultSettings().toolchain, flags: '-std=c++17 -flto' }
        await expect(compileSource(sourcePath, source, tc, false)).resolves.toMatchObject({
            ok: false,
            output: expect.stringMatching(/-flto.*ASCII.*-fuse-ld/),
            cached: false
        })
        expect(tc.flags).toBe('-std=c++17 -flto')
    })
})
