import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadProblem, problemDir, readTests, writeTest } from '../problem/store'
import { applyImport, previewImport } from './index'
import { writeZip } from './fixtures/zip'

let temporary: string, source: string
beforeEach(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-import-safety-'))
    vi.stubEnv('ITER_STORE', path.join(temporary, 'store'))
    source = path.join(temporary, 'solution.cpp')
    await fs.writeFile(source, 'int main() {}')
})
afterEach(async () => {
    vi.unstubAllEnvs()
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5 })
})

describe('transactional import regressions', () => {
    it('preserves existing cases when a later replacement ZIP entry is corrupt', async () => {
        await writeTest(source, { name: 'original', input: 'old input', answer: 'old answer' })
        const before = await fs.readFile(path.join(problemDir(source), 'problem.json'))
        const zip = path.join(temporary, 'broken.zip')
        await writeZip(zip, [
            { name: '1.in', content: 'new' },
            { name: '2.in', content: 'bad', corrupt: true }
        ])
        await expect(
            applyImport({ sourcePath: source, preview: await previewImport(zip), replace: true, attachExtras: false })
        ).rejects.toThrow()
        expect(await fs.readFile(path.join(problemDir(source), 'problem.json'))).toEqual(before)
        expect((await readTests(source, 100)).map((test) => [test.name, test.input, test.answer])).toEqual([
            ['original', 'old input', 'old answer']
        ])
    })

    it('rejects a stored ZIP member with invalid CRC before changing the problem', async () => {
        await writeTest(source, { input: 'original', answer: '' })
        const zip = path.join(temporary, 'crc.zip')
        await writeZip(zip, [{ name: '1.in', content: 'original', method: 0 }])
        const bytes = await fs.readFile(zip)
        bytes[30 + Buffer.byteLength('1.in')] ^= 1
        await fs.writeFile(zip, bytes)
        await expect(
            applyImport({ sourcePath: source, preview: await previewImport(zip), replace: true, attachExtras: false })
        ).rejects.toThrow(/CRC|校验/i)
        expect((await readTests(source, 100))[0].input).toBe('original')
    })

    it('preserves damaged problem JSON verbatim rather than silently resetting it', async () => {
        await loadProblem(source)
        const file = path.join(problemDir(source), 'problem.json')
        const original = Buffer.from('\ufeff{"title":"valuable",broken')
        await fs.writeFile(file, original)
        await expect(loadProblem(source)).rejects.toThrow(/JSON|配置/)
        expect(await fs.readFile(file)).toEqual(original)
        const backups = (await fs.readdir(problemDir(source))).filter((name) =>
            name.startsWith('problem.json.corrupt-')
        )
        expect(backups).toHaveLength(1)
        expect(await fs.readFile(path.join(problemDir(source), backups[0]))).toEqual(original)
    })
})
