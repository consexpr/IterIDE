import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ToolchainSettings } from '../../shared/judge'
import { compileSource } from './compile'
import { resourceFile } from './resources'
import { resolveTool } from '../toolchain'
import { getPassthroughRunner, getRunner } from './runner'

vi.mock('./compile', () => ({ compileSource: vi.fn() }))
vi.mock('./resources', () => ({ resourceFile: vi.fn() }))
vi.mock('../toolchain', () => ({ resolveTool: vi.fn(), toolchainEnv: () => process.env }))

describe.skipIf(process.platform !== 'win32')('Windows runner resolution', () => {
    let dir: string
    const tc = { compiler: 'missing-g++' } as ToolchainSettings
    beforeEach(async () => {
        vi.resetAllMocks()
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-runner-resolution-'))
    })
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true })
    })

    it('uses the packaged executable even when the compiler is unavailable', async () => {
        const prebuilt = path.join(dir, 'runner.exe')
        vi.mocked(resourceFile).mockResolvedValue(prebuilt)
        vi.mocked(resolveTool).mockImplementation(() => {
            throw new Error('No compiler')
        })
        expect(await getPassthroughRunner(tc)).toBe(prebuilt)
        expect(resolveTool).not.toHaveBeenCalled()
        expect(compileSource).not.toHaveBeenCalled()
    })

    it('builds the bundled source lazily when no prebuilt executable exists', async () => {
        const source = path.join(dir, 'runner.cpp'),
            exe = path.join(dir, 'built.exe')
        await fs.writeFile(source, 'int main(){return 0;}')
        vi.mocked(resourceFile).mockImplementation(async (relative) => {
            if (relative.endsWith('.exe')) throw new Error('No prebuilt runner')
            return source
        })
        vi.mocked(resolveTool).mockReturnValue({ command: path.join(dir, 'g++.exe'), source: 'configured' })
        vi.mocked(compileSource).mockResolvedValue({
            ok: true,
            exe,
            output: '',
            diagnostics: [],
            timeMs: 1,
            cached: false
        })
        expect(await getRunner(tc)).toBe(exe)
        expect(compileSource).toHaveBeenCalledWith(
            source,
            'int main(){return 0;}',
            expect.objectContaining({ flags: '-std=c++17 -O2 -static' }),
            false,
            '-lpsapi -lshell32',
            expect.any(AbortSignal)
        )
    })

    it('reports a clear failure instead of silently launching an unprotected child', async () => {
        vi.mocked(resourceFile).mockRejectedValue(new Error('No prebuilt runner'))
        vi.mocked(resolveTool).mockImplementation(() => {
            throw new Error('No compiler')
        })
        await expect(getPassthroughRunner(tc)).rejects.toThrow('Windows runner unavailable')
    })
})
