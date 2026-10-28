import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
    attachFile,
    deleteTests,
    importTestFiles,
    loadProblem,
    listTests,
    problemDir,
    readTests,
    readTest,
    TEST_PREVIEW_TOTAL_CHARS,
    saveProblem,
    testDataPaths,
    testFilePaths,
    writeTest
} from './store'

describe('problem store', () => {
    let dir: string, src: string
    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-store-test-'))
        vi.stubEnv('ITER_STORE', path.join(dir, 'store'))
        src = path.join(dir, 'foo.cpp')
        await fs.writeFile(src, 'int main() {}\n')
    })
    afterEach(async () => {
        vi.unstubAllEnvs()
        if (path.dirname(dir) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('iter-store-test-'))
            throw new Error('Invalid cleanup path')
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 })
    })

    it('creates defaults and serializes concurrent test writes without losing order', async () => {
        expect(path.dirname(problemDir(src))).toBe(path.join(dir, 'store', 'problems'))
        expect((await loadProblem(src)).title).toBe('foo')
        const ids = await Promise.all(
            Array.from({ length: 12 }, (_, i) => writeTest(src, { input: `${i}`, answer: `${i}` }))
        )
        expect(ids).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 1)))
        await writeTest(src, { id: '2', name: 'changed', input: 'new', answer: '' })
        const cfg = await loadProblem(src)
        expect(cfg.tests.map((t) => t.id)).toEqual(ids)
        expect(cfg.tests[1].name).toBe('changed')
        await deleteTests(src, ['2', '3'])
        expect((await loadProblem(src)).tests).toHaveLength(10)
        expect((await fs.readdir(problemDir(src))).some((name) => name.endsWith('.tmp'))).toBe(false)
    })

    it.each(['grader', 'uninstalled.output-only.v2'])(
        'preserves %s and opaque mode options across saves and test edits',
        async (mode) => {
            const cfg = await loadProblem(src)
            const modeOptions = {
                outputFile: '../submitted.out',
                label: '原样保留',
                zero: 0,
                enabled: false,
                empty: {},
                nested: { entries: ['answer', null, { score: 0.25 }], missing: null }
            }
            cfg.mode = mode
            cfg.modeOptions = structuredClone(modeOptions)
            await saveProblem(src, cfg)
            expect(await loadProblem(src)).toMatchObject({ mode, modeOptions })
            await writeTest(src, { input: '1', answer: '2' })
            expect(await loadProblem(src)).toMatchObject({ mode, modeOptions })
            expect(JSON.parse(await fs.readFile(path.join(problemDir(src), 'problem.json'), 'utf8'))).toMatchObject({
                mode,
                modeOptions
            })
            expect(cfg.modeOptions).toEqual(modeOptions)
        }
    )

    it('defaults an empty mode id and ignores non-object options while retaining empty option objects', async () => {
        await loadProblem(src)
        const file = path.join(problemDir(src), 'problem.json')
        for (const modeOptions of [null, [], 'invalid', 42]) {
            await fs.writeFile(file, JSON.stringify({ mode: '', modeOptions }))
            const cfg = await loadProblem(src)
            expect(cfg.mode).toBe('standard')
            expect(cfg.modeOptions).toBeUndefined()
        }
        await fs.writeFile(file, JSON.stringify({ mode: 'unavailable-mode', modeOptions: {} }))
        expect(await loadProblem(src)).toMatchObject({ mode: 'unavailable-mode', modeOptions: {} })
    })

    it('fills missing fields, removes missing inputs, and appends orphan inputs', async () => {
        await loadProblem(src)
        await fs.writeFile(
            path.join(problemDir(src), 'problem.json'),
            JSON.stringify({
                title: 'custom',
                timeLimit: -1,
                checker: {},
                fileIO: { enabled: true },
                tests: [{ id: 'gone' }]
            })
        )
        await fs.writeFile(testFilePaths(src, '7').input, 'hello')
        const cfg = await loadProblem(src)
        expect(cfg.title).toBe('custom')
        expect(cfg.timeLimit).toBe(1000)
        expect(cfg.checker.builtin).toBe('tokens')
        expect(cfg.fileIO).toEqual({ enabled: true, input: 'foo.in', output: 'foo.out' })
        expect(cfg.tests.map((t) => t.id)).toEqual(['7'])
        await fs.writeFile(path.join(problemDir(src), 'problem.json'), '{broken')
        await expect(loadProblem(src)).rejects.toThrow(/JSON/)
        expect(await fs.readFile(path.join(problemDir(src), 'problem.json'), 'utf8')).toBe('{broken')
    })

    it('reads bounded UTF-8 previews with byte sizes and preserves saved metadata', async () => {
        const input = '汉🙂'.repeat(100_000)
        await writeTest(src, { input, answer: 'x' })
        const cfg = await loadProblem(src)
        cfg.tests[0].enabled = false
        await saveProblem(src, cfg)
        const [test] = await readTests(src, 12)
        expect(test.input).toBe(input.slice(0, 12))
        expect(test.inputSize).toBe(Buffer.byteLength(input))
        expect(test.answerSize).toBe(1)
        expect(test.enabled).toBe(false)
        expect(test.truncated).toBe(true)
        expect((await readTests(src, 0))[0].input).toBe('')
    })

    it('lists metadata without retaining content and loads only the requested test preview', async () => {
        const id = await writeTest(src, { input: 'input text', answer: 'answer text' })
        expect(await listTests(src)).toEqual([
            expect.objectContaining({
                id,
                input: '',
                answer: '',
                inputSize: 10,
                answerSize: 11,
                previewLoaded: false
            })
        ])
        expect(await readTest(src, id, 5)).toMatchObject({
            id,
            input: 'input',
            answer: 'answe',
            truncated: true,
            previewLoaded: true
        })
        await expect(readTest(src, 'missing', 5)).rejects.toThrow(/不存在/)
    })

    it('bounds aggregate previews and concurrent metadata reads for a large test collection', async () => {
        const cfg = await loadProblem(src)
        const content = 'x'.repeat(100_000)
        cfg.tests = Array.from({ length: 24 }, (_, index) => ({
            id: `case-${index}`,
            name: String(index),
            enabled: true
        }))
        for (const test of cfg.tests) {
            const files = testFilePaths(src, test.id)
            await fs.writeFile(files.input, content)
            await fs.writeFile(files.answer, content)
        }
        await saveProblem(src, cfg)
        const preview = await readTests(src, 100_000)
        expect(preview.reduce((total, test) => total + test.input.length + test.answer.length, 0)).toBeLessThanOrEqual(
            TEST_PREVIEW_TOTAL_CHARS
        )
        expect(preview.every((test) => test.truncated)).toBe(true)
        const stat = fs.stat.bind(fs)
        let active = 0,
            peak = 0
        vi.spyOn(fs, 'stat').mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
            active++
            peak = Math.max(peak, active)
            try {
                await new Promise((resolve) => setImmediate(resolve))
                return await stat(...args)
            } finally {
                active--
            }
        }) as typeof fs.stat)
        try {
            expect(await listTests(src)).toHaveLength(24)
            expect(peak).toBeLessThanOrEqual(16)
        } finally {
            vi.restoreAllMocks()
        }
    })

    it('reads cached data with bounded previews without changing the originals', async () => {
        const input = path.join(dir, 'bot1.in'),
            answer = path.join(dir, 'bot1.ans')
        const content = '汉🙂'.repeat(100_000)
        await fs.writeFile(input, content)
        await fs.writeFile(answer, 'original answer')
        const id = await importTestFiles(src, { name: 'bot1', input, answer }, true)
        let config = await loadProblem(src)
        expect(testDataPaths(src, config.tests[0])).toEqual(testFilePaths(src, id))
        const [preview] = await readTests(src, 11)
        expect(preview).toMatchObject({
            input: content.slice(0, 11),
            inputSize: Buffer.byteLength(content),
            truncated: true
        })
        config.tests[0].enabled = false
        config.tests[0].timeLimit = 321
        await saveProblem(src, config)
        await writeTest(src, { id, input: 'edited', answer: 'new answer' })
        config = await loadProblem(src)
        expect(config.tests[0]).toMatchObject({ id, name: 'bot1', enabled: false, timeLimit: 321 })
        expect(config.tests[0].link).toBeUndefined()
        expect((await readTests(src, 100))[0]).toMatchObject({ input: 'edited', answer: 'new answer' })
        expect(await fs.readFile(input, 'utf8')).toBe(content)
        expect(await fs.readFile(answer, 'utf8')).toBe('original answer')
        await deleteTests(src, [id])
        expect(await fs.readFile(input, 'utf8')).toBe(content)
    })

    it('deduplicates concurrent linked imports by resolved paths and keeps existing case metadata', async () => {
        const input = path.join(dir, 'case.in'),
            answer = path.join(dir, 'case.ans')
        await fs.writeFile(input, 'input')
        await fs.writeFile(answer, 'answer')
        const id = await importTestFiles(src, { name: 'original', input, answer, sample: true }, true)
        const cfg = await loadProblem(src)
        cfg.tests[0].name = 'user name'
        cfg.tests[0].enabled = false
        cfg.tests[0].timeLimit = 321
        await saveProblem(src, cfg)
        const alias = (file: string): string => `${dir}${path.sep}unused${path.sep}..${path.sep}${path.basename(file)}`
        const ids = await Promise.all(
            Array.from({ length: 8 }, (_, i) =>
                importTestFiles(
                    src,
                    {
                        name: 'reimported',
                        input: process.platform === 'win32' && i % 2 ? input.toUpperCase() : alias(input),
                        answer: process.platform === 'win32' && i % 2 ? answer.toUpperCase() : alias(answer)
                    },
                    true
                )
            )
        )
        expect(ids).toEqual(Array(8).fill(id))
        expect((await loadProblem(src)).tests).toEqual([
            { id, name: 'user name', enabled: false, sample: true, timeLimit: 321, link: { input, answer } }
        ])
    })

    it('updates, adds and removes an existing answer link without replacing its case ID', async () => {
        const input = path.join(dir, 'case.in'),
            oldAnswer = path.join(dir, 'case.out'),
            answer = path.join(dir, 'case.ans')
        await fs.writeFile(input, 'input')
        await fs.writeFile(oldAnswer, 'answer')
        const id = await importTestFiles(src, { name: 'case', input }, true)
        expect(await importTestFiles(src, { name: 'case', input, answer: oldAnswer }, true)).toBe(id)
        await fs.rename(oldAnswer, answer)
        expect(await importTestFiles(src, { name: 'case', input, answer }, true)).toBe(id)
        expect((await readTests(src, 100))[0]).toMatchObject({ id, answer: 'answer', link: { input, answer } })
        expect(await importTestFiles(src, { name: 'case', input }, true)).toBe(id)
        expect((await loadProblem(src)).tests).toEqual([{ id, name: 'case', enabled: true, link: { input } }])
        expect(await fs.readFile(answer, 'utf8')).toBe('answer')
    })

    it('keeps different linked inputs and repeated copied imports separate even with identical content', async () => {
        const input = path.join(dir, 'first.in'),
            other = path.join(dir, 'second.in'),
            answer = path.join(dir, 'case.ans')
        await fs.writeFile(input, 'same input')
        await fs.copyFile(input, other)
        await fs.writeFile(answer, 'answer')
        const first = await importTestFiles(src, { name: 'first', input, answer }, true)
        const second = await importTestFiles(src, { name: 'second', input: other, answer }, true)
        const copied = await importTestFiles(src, { name: 'copy', input, answer }, false)
        const copiedAgain = await importTestFiles(src, { name: 'copy', input, answer }, false)
        expect(new Set([first, second, copied, copiedAgain]).size).toBe(4)
        expect(await importTestFiles(src, { name: 'second', input: other, answer }, true)).toBe(second)
        expect((await loadProblem(src)).tests).toHaveLength(4)
        // Editing a link converts it to owned data; it must not suppress a later linked import.
        await writeTest(src, { id: first, input: 'edited', answer: '' })
        expect(await importTestFiles(src, { name: 'first', input, answer }, true)).not.toBe(first)
        expect((await loadProblem(src)).tests).toHaveLength(5)
    })

    it('deletes cached data only and retains snapshots after the external files disappear', async () => {
        const input = path.join(dir, 'perm1.in'),
            answer = path.join(dir, 'perm1.out')
        await fs.writeFile(input, '1')
        await fs.writeFile(answer, '2')
        const id = await importTestFiles(src, { name: 'perm1', input, answer }, true)
        await deleteTests(src, [id])
        expect((await loadProblem(src)).tests).toEqual([])
        expect(await fs.readFile(input, 'utf8')).toBe('1')
        expect(await fs.readFile(answer, 'utf8')).toBe('2')
        await importTestFiles(src, { name: 'perm1', input, answer }, true)
        await fs.rm(answer)
        const report = vi.fn()
        expect((await loadProblem(src, report)).tests).toHaveLength(1)
        expect((await readTests(src, 100))[0].answer).toBe('2')
        expect(report).not.toHaveBeenCalled()
        await importTestFiles(src, { name: 'without answer', input }, true)
        expect((await readTests(src, 100))[0].answer).toBe('')
        await fs.rm(input)
        expect((await loadProblem(src, report)).tests).toHaveLength(1)
        expect((await readTests(src, 100))[0].input).toBe('1')
        expect(report).not.toHaveBeenCalled()
    })

    it('copies attached tools and rejects unsafe test ids', async () => {
        const tool = path.join(dir, 'spj.cpp')
        await fs.writeFile(tool, '// checker')
        const relative = await attachFile(src, tool, 'checker')
        expect(await fs.readFile(path.join(problemDir(src), relative), 'utf8')).toBe('// checker')
        expect(() => testFilePaths(src, '../outside')).toThrow('Invalid test id')
    })
})
