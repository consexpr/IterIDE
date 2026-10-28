import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normalize } from './config'
import { acquireProblemLease, importTestFiles, loadProblem, readTests, updateTestMeta, writeTest } from './store'

let directory: string, source: string
beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-comparison-store-'))
    vi.stubEnv('ITER_STORE', path.join(directory, 'store'))
    source = path.join(directory, 'main.cpp')
    await fs.writeFile(source, 'int main(){}')
})
afterEach(async () => {
    vi.unstubAllEnvs()
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5 })
})

describe('per-test comparison metadata', () => {
    it('keeps old cases compared by default and accepts only boolean metadata', () => {
        const cfg = normalize(source, {
            tests: [
                { id: '1', name: 'old', enabled: true },
                { id: '2', name: 'off', enabled: true, compareOutput: false },
                { id: '3', name: 'bad', enabled: true, compareOutput: 'false' }
            ]
        })
        expect(cfg.tests.map((test) => test.compareOutput !== false)).toEqual([true, false, true])
    })

    it('persists only the selected test policy and retains both answers through edits and restoration', async () => {
        const first = await writeTest(source, { input: '1', answer: 'saved answer' })
        await writeTest(source, { input: '2', answer: 'other answer' })
        await updateTestMeta(source, first, { compareOutput: false })
        expect((await loadProblem(source)).tests.map((test) => test.compareOutput)).toEqual([false, undefined])
        expect((await readTests(source, 100)).map((test) => test.answer)).toEqual(['saved answer', 'other answer'])
        await writeTest(source, { id: first, input: 'changed', answer: 'saved answer' })
        expect((await loadProblem(source)).tests[0].compareOutput).toBe(false)
        await updateTestMeta(source, first, { compareOutput: true })
        expect((await readTests(source, 100))[0]).toMatchObject({ compareOutput: true, answer: 'saved answer' })
        await expect(updateTestMeta(source, first, { compareOutput: 'false' } as never)).rejects.toThrow('类型无效')
    })

    it('blocks comparison changes while a runtime owns the problem snapshot', async () => {
        const id = await writeTest(source, { input: '1', answer: 'answer' })
        const release = await acquireProblemLease(source)
        try {
            await expect(updateTestMeta(source, id, { compareOutput: false })).rejects.toThrow('正在运行或调试')
        } finally {
            release()
        }
        expect((await loadProblem(source)).tests[0].compareOutput).toBeUndefined()
    })

    it('uses the cached answer after external deletion and ignores later external changes', async () => {
        const input = path.join(directory, 'input.in'),
            answer = path.join(directory, 'answer.ans')
        await fs.writeFile(input, 'input')
        await fs.writeFile(answer, 'expected')
        const id = await importTestFiles(source, { name: 'linked', input, answer }, true)
        await updateTestMeta(source, id, { compareOutput: false })
        await fs.rm(answer)
        expect((await loadProblem(source)).tests[0]).toMatchObject({
            id,
            compareOutput: false,
            link: { input, answer }
        })
        expect((await readTests(source, 100))[0]).toMatchObject({ id, input: 'input', answer: 'expected' })
        await updateTestMeta(source, id, { compareOutput: true })
        await fs.writeFile(answer, 'restored')
        await updateTestMeta(source, id, { compareOutput: true })
        expect((await readTests(source, 100))[0]).toMatchObject({ compareOutput: true, answer: 'expected' })
    })
})
