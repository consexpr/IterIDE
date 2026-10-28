import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    acquireProblemLease,
    deleteTests,
    importProblemBatch,
    loadProblem,
    patchProblem,
    problemDir,
    readTests,
    testFilePaths,
    updateTestMeta,
    writeTest
} from './store'
import { createImportTransaction } from './transaction'
import { atomicWrite } from './atomic'

let temporary: string, source: string, root: string, oldId: string
const hash = (data: Buffer): string => createHash('sha256').update(data).digest('hex')
beforeEach(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-transaction-'))
    vi.stubEnv('ITER_STORE', path.join(temporary, 'store'))
    source = path.join(temporary, 'source.cpp')
    await fs.writeFile(source, 'int main() {}')
    oldId = await writeTest(source, { name: 'old', input: 'old input', answer: 'old answer' })
    root = problemDir(source)
})
afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5 })
})
async function interrupted(phase: 'prepared' | 'committed', publishedConfig: boolean) {
    const tx = await createImportTransaction(root)
    const before = await fs.readFile(path.join(root, 'problem.json'))
    const next = JSON.parse(before.toString()),
        id = `import-${tx.id}-0`
    next.tests = [{ id, name: 'new', enabled: true }]
    const after = Buffer.from(JSON.stringify(next, null, 2) + '\n')
    const added = [`tests/${id}.in`, `tests/${id}.ans`]
    await fs.writeFile(path.join(root, added[0]), 'new input')
    await fs.writeFile(path.join(root, added[1]), 'new answer')
    await fs.writeFile(path.join(tx.stage, 'before.json'), before)
    await fs.writeFile(path.join(tx.stage, 'after.json'), after)
    await fs.writeFile(
        path.join(tx.stage, 'journal.json'),
        JSON.stringify({
            version: 1,
            phase,
            before: hash(before),
            after: hash(after),
            added,
            retired: [`tests/${oldId}.in`, `tests/${oldId}.ans`]
        })
    )
    if (publishedConfig) await atomicWrite(path.join(root, 'problem.json'), after)
    return { tx, added, before, after }
}

describe('import transaction recovery', () => {
    it('rolls back both sides of an ordinary edit when publishing its answer fails', async () => {
        await loadProblem(source)
        const paths = testFilePaths(source, oldId)
        const rename = fs.rename.bind(fs)
        vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
            if (String(to) === paths.answer) throw Object.assign(new Error('answer failed'), { code: 'EIO' })
            return rename(from, to)
        })
        await expect(writeTest(source, { id: oldId, input: 'new input', answer: 'new answer' })).rejects.toThrow(
            'answer failed'
        )
        expect(await fs.readFile(paths.input, 'utf8')).toBe('old input')
        expect(await fs.readFile(paths.answer, 'utf8')).toBe('old answer')
        expect((await loadProblem(source)).tests[0].id).toBe(oldId)
    })

    it('keeps deleted test files intact when the metadata commit fails', async () => {
        await loadProblem(source)
        const rename = fs.rename.bind(fs)
        vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
            if (String(to) === path.join(root, 'problem.json'))
                throw Object.assign(new Error('config failed'), { code: 'EIO' })
            return rename(from, to)
        })
        await expect(deleteTests(source, [oldId])).rejects.toThrow('config failed')
        const files = testFilePaths(source, oldId)
        expect(await fs.readFile(files.input, 'utf8')).toBe('old input')
        expect(await fs.readFile(files.answer, 'utf8')).toBe('old answer')
    })

    it.each([false, true])(
        'recovers interrupted content-only edits across the metadata commit point: committed=%s',
        async (committed) => {
            await loadProblem(source)
            const tx = await createImportTransaction(root)
            const before = await fs.readFile(path.join(root, 'problem.json'))
            const after = Buffer.from(JSON.stringify({ ...JSON.parse(before.toString()), storageTransaction: tx.id }))
            const replaced = []
            await fs.mkdir(path.join(tx.stage, 'original', 'tests'), { recursive: true })
            for (const [extension, old, next] of [
                ['in', 'old input', 'new input'],
                ['ans', 'old answer', 'new answer']
            ]) {
                const file = `tests/${oldId}.${extension}`
                await fs.writeFile(path.join(tx.stage, 'original', file), old)
                await fs.writeFile(path.join(root, file), next)
                replaced.push({ file, before: hash(Buffer.from(old)), after: hash(Buffer.from(next)) })
            }
            await fs.writeFile(
                path.join(tx.stage, 'journal.json'),
                JSON.stringify({
                    version: 1,
                    phase: 'prepared',
                    before: hash(before),
                    after: hash(after),
                    added: [],
                    retired: [],
                    replaced
                })
            )
            if (committed) await fs.writeFile(path.join(root, 'problem.json'), after)
            const [test] = await readTests(source, 100)
            expect(test.input).toBe(committed ? 'new input' : 'old input')
            expect(test.answer).toBe(committed ? 'new answer' : 'old answer')
            await expect(fs.stat(tx.stage)).rejects.toThrow(/ENOENT/)
        }
    )

    it('rolls back a prepared publication before orphan inputs can become tests', async () => {
        const state = await interrupted('prepared', false)
        expect((await loadProblem(source)).tests.map((test) => test.id)).toEqual([oldId])
        expect(await fs.readFile(path.join(root, 'problem.json'))).toEqual(state.before)
        await expect(fs.stat(path.join(root, state.added[0]))).rejects.toThrow(/ENOENT/)
    })

    it('recognizes a committed config even when the committed journal update was interrupted', async () => {
        const { tx } = await interrupted('prepared', true)
        expect((await readTests(source, 100)).map((test) => test.input)).toEqual(['new input'])
        await expect(fs.stat(path.join(root, 'tests', `${oldId}.in`))).rejects.toThrow(/ENOENT/)
        await expect(fs.stat(tx.stage)).rejects.toThrow(/ENOENT/)
        expect((await loadProblem(source)).tests).toHaveLength(1)
    })

    it('keeps the old source anchor while recovering an import after a source move', async () => {
        await fs.writeFile(path.join(temporary, 'checker.cpp'), '// checker')
        await patchProblem(source, { checker: { kind: 'custom', path: 'checker.cpp', relativeTo: 'source' } })
        await interrupted('committed', true)
        const destination = path.join(temporary, 'moved', 'source.cpp')
        await fs.mkdir(path.dirname(destination))
        await fs.rename(source, destination)
        expect((await loadProblem(destination)).checker.path).toMatch(/^resources\//)
    })

    it('does not revive retired inputs when Windows delays cleanup, including after another settings save', async () => {
        const { tx } = await interrupted('committed', true)
        const remove = fs.rm.bind(fs)
        const blocked = path.join(root, 'tests', `${oldId}.in`)
        vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
            if (String(target) === blocked) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
            return remove(target, options)
        })
        const report = vi.fn()
        expect((await loadProblem(source, report)).tests.map((test) => test.name)).toEqual(['new'])
        expect(report).toHaveBeenCalled()
        await patchProblem(source, { title: 'later title' })
        expect((await loadProblem(source, report)).tests).toHaveLength(1)
        vi.restoreAllMocks()
        expect((await loadProblem(source)).title).toBe('later title')
        await expect(fs.stat(tx.stage)).rejects.toThrow(/ENOENT/)
    })

    it('preserves all evidence when a prepared journal disagrees with the current config', async () => {
        const { tx, added } = await interrupted('prepared', false)
        await fs.writeFile(path.join(root, 'problem.json'), '{"title":"external edit"}')
        await expect(loadProblem(source)).rejects.toThrow(/无法确定导入事务/)
        expect(await fs.readFile(path.join(root, added[0]), 'utf8')).toBe('new input')
        expect(await fs.stat(tx.stage)).toBeTruthy()
    })

    it('rolls back published new files when replacing problem.json fails', async () => {
        const before = await fs.readFile(path.join(root, 'problem.json')),
            rename = fs.rename.bind(fs)
        vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
            if (String(to) === path.join(root, 'problem.json'))
                throw Object.assign(new Error('locked config'), { code: 'EPERM' })
            return rename(from, to)
        })
        await expect(
            importProblemBatch(source, {
                replace: true,
                tests: [{ name: 'new', input: (target) => atomicWrite(target, 'new input') }]
            })
        ).rejects.toThrow(/locked config/)
        expect(await fs.readFile(path.join(root, 'problem.json'))).toEqual(before)
        expect((await fs.readdir(path.join(root, 'tests'))).sort()).toEqual([`${oldId}.ans`, `${oldId}.in`])
    })

    it('reports post-commit snapshot failure without rolling back the imported data', async () => {
        const read = fs.readFile.bind(fs),
            report = vi.fn()
        vi.spyOn(fs, 'readFile').mockImplementation(((file: unknown, ...args: unknown[]) => {
            if (String(file) === source)
                return Promise.reject(Object.assign(new Error('snapshot denied'), { code: 'EACCES' }))
            return (read as (...args: unknown[]) => unknown)(file, ...args)
        }) as typeof fs.readFile)
        expect(
            await importProblemBatch(
                source,
                { replace: true, tests: [{ name: 'new', input: (target) => atomicWrite(target, 'new input') }] },
                report
            )
        ).toEqual({ added: 1 })
        expect(report).toHaveBeenCalled()
        vi.restoreAllMocks()
        expect((await readTests(source, 100)).map((test) => test.input)).toEqual(['new input'])
        expect((await fs.readdir(root)).some((name) => name.startsWith('.import-'))).toBe(false)
    })
})

describe('lock-scoped settings and metadata changes', () => {
    it('merges independent settings patches into the newest test collection', async () => {
        await Promise.all([
            patchProblem(source, { title: 'new title' }),
            writeTest(source, { input: 'second', answer: '' }),
            patchProblem(source, { timeLimit: 2345 })
        ])
        expect(await loadProblem(source)).toMatchObject({
            title: 'new title',
            timeLimit: 2345,
            tests: [{ id: oldId }, { id: '2' }]
        })
        await updateTestMeta(source, oldId, { enabled: false, name: 'renamed' })
        expect((await readTests(source, 100))[0]).toMatchObject({ name: 'renamed', enabled: false, input: 'old input' })
        await expect(patchProblem(source, { tests: [] } as never)).rejects.toThrow(/tests/)
        await expect(updateTestMeta(source, oldId, { id: 'other' } as never)).rejects.toThrow(/元数据/)
        await expect(updateTestMeta(source, oldId, { timeLimit: Infinity })).rejects.toThrow(/时间限制/)
        await expect(updateTestMeta(source, 'missing', { enabled: false })).rejects.toThrow(/不存在/)
    })

    it('holds a lease across a run and releases it idempotently', async () => {
        const release = await acquireProblemLease(source)
        await expect(importProblemBatch(source, { replace: true, tests: [] })).rejects.toThrow(/正在运行/)
        await expect(deleteTests(source, [oldId])).rejects.toThrow(/正在运行/)
        release()
        release()
        await importProblemBatch(source, { replace: true, tests: [] })
        expect((await loadProblem(source)).tests).toEqual([])
    })

    it('does not overwrite damaged configuration even if preserving its recovery copy fails', async () => {
        const original = Buffer.from('{broken'),
            file = path.join(root, 'problem.json')
        await fs.writeFile(file, original)
        const open = fs.open.bind(fs)
        vi.spyOn(fs, 'open').mockImplementation(((target: unknown, ...args: unknown[]) => {
            if (String(target).includes('problem.json.corrupt-'))
                return Promise.reject(Object.assign(new Error('backup denied'), { code: 'EACCES' }))
            return (open as (...values: unknown[]) => unknown)(target, ...args)
        }) as typeof fs.open)
        await expect(loadProblem(source)).rejects.toThrow(/无法保存恢复副本/)
        expect(await fs.readFile(file)).toEqual(original)
    })
})
