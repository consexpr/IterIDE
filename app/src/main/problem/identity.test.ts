import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from 'vitest'
import {
    discardSource,
    ensureIdentity,
    importTestFiles,
    loadProblem,
    moveSource,
    problemDir,
    readTests,
    removeProblem,
    saveProblem,
    snapshotCode,
    writeTest
} from './store'
import { bindIdentity } from './identity'
import { storeRoot } from './root'
import { LEGACY_IDENTITY_NAME, LEGACY_STORE_NAME } from '../legacyStorage'

const stored = async (): Promise<string[]> => fs.readdir(path.join(storeRoot(), 'problems')).catch(() => [] as string[])
import { defaultProblem } from '../../shared/problem'

let temporary: string, source: string
beforeEach(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-identity-'))
    vi.stubEnv('ITER_STORE', path.join(temporary, 'store'))
    source = path.join(temporary, 'solution.cpp')
    await fs.writeFile(source, 'int main() {}\n')
})
afterEach(async () => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    if (path.dirname(temporary) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('iter-identity-'))
        throw new Error('Invalid cleanup path')
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5 })
})
async function ads(context: TestContext): Promise<string> {
    if (process.platform !== 'win32') {
        context.skip('NTFS ADS test')
        return ''
    }
    await loadProblem(source)
    try {
        return await fs.readFile(`${source}:iter.id`, 'utf8')
    } catch {
        context.skip('Volume does not support ADS')
        return ''
    }
}
async function stripIdentity(file: string): Promise<void> {
    const replacement = `${file}.replacement`
    await fs.writeFile(replacement, await fs.readFile(file))
    await fs.rename(replacement, file)
}

describe('central store and deterministic source identity', () => {
    it('recognizes a renamed file carrying an old identity and writes the ITER identity without deleting it', async (context) => {
        const id = await ads(context)
        await writeTest(source, { input: 'preserved test', answer: '' })
        const originalDir = problemDir(source)
        await stripIdentity(source)
        await fs.writeFile(`${source}:${LEGACY_IDENTITY_NAME}`, id)
        const moved = path.join(temporary, 'renamed.cpp')
        await fs.rename(source, moved)
        expect((await readTests(moved, 100))[0].input).toBe('preserved test')
        expect(problemDir(moved)).toBe(originalDir)
        expect(await fs.readFile(`${moved}:iter.id`, 'utf8')).toBe(id)
        expect(await fs.readFile(`${moved}:${LEGACY_IDENTITY_NAME}`, 'utf8')).toBe(id)
    })
    it('uses the home store by default and resolves ITER_STORE at call time', () => {
        expect(storeRoot()).toBe(path.join(temporary, 'store'))
        vi.stubEnv('ITER_STORE', '')
        expect(storeRoot()).toBe(path.join(os.homedir(), '.iter'))
    })

    it('persists index, metadata and every save snapshot without writing a sidecar', async () => {
        const before = await fs.stat(source),
            content = await fs.readFile(source)
        const cfg = await loadProblem(source)
        cfg.title = '中文标题'
        await saveProblem(source, cfg)
        const dir = problemDir(source),
            id = path.basename(dir)
        expect(await fs.readFile(source)).toEqual(content)
        expect(Math.abs((await fs.stat(source)).mtimeMs - before.mtimeMs)).toBeLessThan(1)
        expect(JSON.parse(await fs.readFile(path.join(storeRoot(), 'index.json'), 'utf8'))).toEqual({ [id]: source })
        expect(JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'))).toMatchObject({
            id,
            sourcePath: source,
            title: '中文标题',
            createdAt: expect.any(Number),
            updatedAt: expect.any(Number)
        })
        await expect(fs.access(path.join(temporary, '.iter'))).rejects.toThrow()
        await fs.writeFile(source, '// saved revision')
        await saveProblem(source, cfg)
        expect(await fs.readFile(path.join(dir, 'code.cpp'), 'utf8')).toBe('// saved revision')
        await fs.writeFile(source, '// test-save revision')
        await writeTest(source, { input: '1', answer: '2' })
        expect(await fs.readFile(path.join(dir, 'code.cpp'), 'utf8')).toBe('// test-save revision')
        await snapshotCode(source, '// editor snapshot')
        expect(await fs.readFile(path.join(dir, 'code.cpp'), 'utf8')).toBe('// editor snapshot')
        expect(await fs.readFile(source, 'utf8')).toBe('// test-save revision')
    })

    it('keeps configuration and absolute links after a rename across directories', async (context) => {
        const id = await ads(context)
        const input = path.join(temporary, 'exam.in')
        await fs.writeFile(input, '42')
        await importTestFiles(source, { name: 'exam', input }, true)
        const dir = problemDir(source),
            cfg = await loadProblem(source)
        expect(cfg.tests[0].link?.input).toBe(input)
        await fs.writeFile(path.join(temporary, 'checker.cpp'), '// checker')
        await fs.writeFile(path.join(temporary, 'grader.cpp'), '// grader')
        cfg.checker = { kind: 'custom', path: 'checker.cpp', relativeTo: 'source' }
        cfg.grader = { sources: ['grader.cpp'], includeDirs: ['headers'] }
        await saveProblem(source, cfg)
        const moved = path.join(temporary, 'moved', 'renamed.cpp')
        await fs.mkdir(path.dirname(moved))
        await fs.rename(source, moved)
        const loaded = await loadProblem(moved)
        expect(problemDir(moved)).toBe(dir)
        expect((await readTests(moved, 100))[0].input).toBe('42')
        expect(loaded.checker.path).toMatch(/^resources\//)
        expect(loaded.grader!.sources.every((file) => file.startsWith(problemDir(moved)))).toBe(true)
        expect(await fs.readFile(loaded.grader!.sources[0], 'utf8')).toBe('// grader')
        expect(JSON.parse(await fs.readFile(path.join(storeRoot(), 'index.json'), 'utf8'))[id]).toBe(moved)
    })

    it('detects an ADS-preserving copy and gives it an independent copy of all configuration', async (context) => {
        const id = await ads(context)
        await writeTest(source, { input: 'original', answer: 'answer' })
        await fs.writeFile(path.join(problemDir(source), 'checker.cpp'), '// attached checker')
        const copy = path.join(temporary, 'copy.cpp')
        await fs.copyFile(source, copy)
        let copiedStream: string | undefined
        try {
            copiedStream = await fs.readFile(`${copy}:iter.id`, 'utf8')
        } catch {
            /* Some copy implementations strip streams. */
        }
        if (copiedStream !== id) {
            context.skip('copyFile did not preserve ADS on this volume')
            return
        }
        expect((await readTests(copy, 100))[0].input).toBe('original')
        expect(problemDir(copy)).not.toBe(problemDir(source))
        expect(await fs.readFile(`${copy}:iter.id`, 'utf8')).not.toBe(id)
        expect(await fs.readFile(path.join(problemDir(copy), 'checker.cpp'), 'utf8')).toBe('// attached checker')
        await writeTest(copy, { id: '1', input: 'copy edit', answer: '' })
        expect((await readTests(source, 100))[0].input).toBe('original')
        expect(await stored()).toHaveLength(2)
    })

    it('rebinds a stripped stream only at the exact original path and ensureIdentity repairs it', async (context) => {
        const id = await ads(context)
        await writeTest(source, { input: 'kept', answer: '' })
        await stripIdentity(source)
        await ensureIdentity(source)
        expect(await fs.readFile(`${source}:iter.id`, 'utf8')).toBe(id)
        await stripIdentity(source)
        expect((await readTests(source, 100))[0].input).toBe('kept')
        expect(await fs.readFile(`${source}:iter.id`, 'utf8')).toBe(id)
    })

    it('does not guess an identity for a stripped stream moved to another path', async (context) => {
        await ads(context)
        await writeTest(source, { input: 'old data', answer: '' })
        const oldDir = problemDir(source)
        await stripIdentity(source)
        const moved = path.join(temporary, 'lost.cpp')
        await fs.rename(source, moved)
        expect((await loadProblem(moved)).tests).toEqual([])
        expect(problemDir(moved)).not.toBe(oldDir)
        expect(await fs.readFile(path.join(oldDir, 'tests', '1.in'), 'utf8')).toBe('old data')
    })

    it('works with exact-path bindings when the source cannot carry an identity', async () => {
        // A not-yet-created source has no inode/stream; store APIs historically allow this.
        await fs.rm(source)
        await writeTest(source, { input: 'path only', answer: '' })
        const dir = problemDir(source)
        expect((await readTests(source, 100))[0].input).toBe('path only')
        await fs.writeFile(source, '// created later')
        await ensureIdentity(source)
        expect(problemDir(source)).toBe(dir)
    })

    it('removes only central data', async () => {
        const linked = path.join(temporary, 'linked.in')
        await fs.writeFile(linked, 'data')
        await importTestFiles(source, { name: 'linked', input: linked }, true)
        await snapshotCode(source, '// snapshot')
        const id = path.basename(problemDir(source))
        expect(await stored()).toEqual([id])
        await removeProblem(id)
        expect(await stored()).toEqual([])
        expect(await fs.readFile(source, 'utf8')).toBe('int main() {}\n')
        expect(await fs.readFile(linked, 'utf8')).toBe('data')
        expect(JSON.parse(await fs.readFile(path.join(storeRoot(), 'index.json'), 'utf8'))).toEqual({})
        await expect(removeProblem('../outside')).rejects.toThrow('ID')
    })

    it('moves a problem with its source and replaces what the destination had', async () => {
        await writeTest(source, { id: '1', input: 'moved', answer: 'a' })
        const id = path.basename(problemDir(source))
        const target = path.join(temporary, 'saved.cpp')
        await fs.writeFile(target, '// new place\n')
        const other = await (async () => {
            await loadProblem(target)
            await writeTest(target, { id: '1', input: 'old', answer: '' })
            return path.basename(problemDir(target))
        })()
        expect(other).not.toBe(id)
        await moveSource(source, target)
        expect(path.basename(problemDir(target))).toBe(id)
        expect((await readTests(target, 100)).map((t) => t.input)).toEqual(['moved'])
        expect(await stored()).toEqual([id])
        expect(JSON.parse(await fs.readFile(path.join(problemDir(target), 'meta.json'), 'utf8')).sourcePath).toBe(
            path.resolve(target)
        )
    })

    it('discards the problem bound to a path without creating one for an unknown path', async () => {
        await writeTest(source, { id: '1', input: 'x', answer: '' })
        await discardSource(path.join(temporary, 'never-seen.cpp'))
        expect(await stored()).toHaveLength(1)
        await discardSource(source)
        expect(await stored()).toEqual([])
    })

    it('does not overwrite a corrupt index with an empty one', async () => {
        await fs.mkdir(storeRoot())
        await fs.writeFile(path.join(storeRoot(), 'index.json'), '{broken')
        await expect(loadProblem(source)).rejects.toThrow('索引')
        expect(await fs.readFile(path.join(storeRoot(), 'index.json'), 'utf8')).toBe('{broken')
    })

    it('relocates owned graders of a synced source under the current store root', async () => {
        const cfg = await loadProblem(source),
            originalDir = problemDir(source),
            id = path.basename(originalDir)
        const grader = path.join(originalDir, 'judge', 'grader.cpp')
        await fs.mkdir(path.dirname(grader), { recursive: true })
        await fs.writeFile(grader, '// owned grader')
        cfg.grader = { sources: [grader], includeDirs: [originalDir, path.dirname(grader)] }
        await saveProblem(source, cfg)
        const secondRoot = path.join(temporary, 'synced-store'),
            secondDir = path.join(secondRoot, 'problems', id)
        await fs.cp(originalDir, secondDir, { recursive: true })
        const meta = JSON.parse(await fs.readFile(path.join(secondDir, 'meta.json'), 'utf8'))
        meta.sourcePath = process.platform === 'win32' ? '/foreign-host/source.cpp' : 'Z:\\foreign-host\\source.cpp'
        await fs.writeFile(path.join(secondDir, 'meta.json'), JSON.stringify(meta))
        vi.stubEnv('ITER_STORE', secondRoot)
        const restored = path.join(temporary, 'synced.cpp')
        await fs.writeFile(restored, '// synced code')
        bindIdentity(restored, id)
        const loaded = await loadProblem(restored)
        expect(loaded.grader!.sources[0].startsWith(secondDir)).toBe(true)
        expect(await fs.readFile(loaded.grader!.sources[0], 'utf8')).toBe('// owned grader')
        expect(loaded.grader!.includeDirs!.every((file) => file.startsWith(secondDir))).toBe(true)
        expect(await fs.readFile(loaded.grader!.sources[0], 'utf8')).toBe('// owned grader')
    })
})

describe('legacy migration', () => {
    it('imports a sidecar created under the old brand while leaving its files untouched', async () => {
        const previous = path.join(temporary, LEGACY_STORE_NAME, 'solution', 'tests')
        await fs.mkdir(previous, { recursive: true })
        await fs.writeFile(path.join(previous, 'original.in'), 'legacy input')
        expect((await readTests(source, 100))[0].input).toBe('legacy input')
        expect(await fs.readFile(path.join(previous, 'original.in'), 'utf8')).toBe('legacy input')
        expect(problemDir(source).startsWith(storeRoot())).toBe(true)
    })
    const fixture = path.resolve(import.meta.dirname, '../../../../smp/10.19down/necklace/.iter/untitled1')
    it('preserves an unavailable mode and options through migration and snapshot restoration', async () => {
        const legacy = path.join(temporary, '.iter', 'solution')
        const mode = 'uninstalled.legacy-mode',
            modeOptions = { outputFile: './results/out.txt', nested: [null, { enabled: false, value: 0 }], empty: {} }
        const cfg = { ...defaultProblem('legacy plugin'), mode, modeOptions }
        const original = JSON.stringify(cfg, null, 2)
        await fs.mkdir(legacy, { recursive: true })
        await fs.writeFile(path.join(legacy, 'problem.json'), original)
        expect(await loadProblem(source)).toMatchObject({ mode, modeOptions })
        const id = path.basename(problemDir(source))
        await fs.rm(source)
        const restored = path.join(temporary, 'restored.cpp')
        await fs.writeFile(restored, '// moved code')
        bindIdentity(restored, id)
        expect(await loadProblem(restored)).toMatchObject({ mode, modeOptions })
        expect(await fs.readFile(path.join(legacy, 'problem.json'), 'utf8')).toBe(original)
        expect(JSON.parse(await fs.readFile(path.join(problemDir(restored), 'problem.json'), 'utf8'))).toMatchObject({
            mode,
            modeOptions
        })
    })
    it('migrates orphan inputs even when the old sidecar has no problem.json', async () => {
        const legacy = path.join(temporary, '.iter', 'solution', 'tests')
        await fs.mkdir(legacy, { recursive: true })
        await fs.writeFile(path.join(legacy, 'sample.in'), '12 34Z')
        expect((await loadProblem(source)).tests).toEqual([{ id: 'sample', name: 'sample', enabled: true }])
        expect((await readTests(source, 100))[0].input).toBe('12 34Z')
    })
    it.skipIf(!existsSync(path.join(fixture, 'problem.json')))(
        'copies the real necklace sidecar and leaves the old folder untouched',
        async () => {
            source = path.join(temporary, 'untitled1.cpp')
            await fs.writeFile(source, '// necklace')
            const legacy = path.join(temporary, '.iter', 'untitled1')
            await fs.cp(fixture, legacy, { recursive: true })
            const original = await fs.readFile(path.join(legacy, 'problem.json'))
            const before = await fs.readdir(legacy, { recursive: true })
            expect(await loadProblem(source)).toMatchObject({
                fileIO: { enabled: true, input: 's.in', output: 's.out' },
                tests: [{ id: '1' }]
            })
            expect((await readTests(source, 100))[0].input).toBe(
                await fs.readFile(path.join(fixture, 'tests', '1.in'), 'utf8')
            )
            expect(await fs.readFile(path.join(legacy, 'problem.json'))).toEqual(original)
            expect(await fs.readdir(legacy, { recursive: true })).toEqual(before)
            await writeTest(source, { id: '1', input: 'central edit', answer: '' })
            expect(await fs.readFile(path.join(legacy, 'tests', '1.in'))).toEqual(
                await fs.readFile(path.join(fixture, 'tests', '1.in'))
            )
        }
    )

    it('makes legacy links absolute and preserves attached tools and source-relative grader inputs', async () => {
        const legacy = path.join(temporary, '.iter', 'solution')
        await fs.mkdir(path.join(legacy, 'tests'), { recursive: true })
        await fs.writeFile(path.join(temporary, 'case.in'), 'legacy input')
        await fs.writeFile(path.join(legacy, 'checker.cpp'), '// checker')
        await fs.writeFile(path.join(legacy, 'grader.cpp'), '// attached grader')
        await fs.writeFile(path.join(temporary, 'grader.cpp'), '// external grader')
        await fs.writeFile(
            path.join(legacy, 'problem.json'),
            JSON.stringify({
                title: 'legacy',
                checker: { kind: 'custom', path: 'checker.cpp' },
                grader: {
                    sources: ['grader.cpp', '.iter/solution/grader.cpp'],
                    includeDirs: ['headers', '.iter/solution']
                },
                tests: [{ id: 'linked', name: 'linked', enabled: true, link: { input: 'case.in' } }]
            })
        )
        const cfg = await loadProblem(source)
        expect(cfg.tests[0].link).toEqual({ input: path.join(temporary, 'case.in') })
        expect(cfg.grader!.sources.every((file) => file.startsWith(problemDir(source)))).toBe(true)
        expect(await fs.readFile(cfg.grader!.sources[1], 'utf8')).toBe('// attached grader')
        expect(await fs.readFile(path.join(problemDir(source), cfg.checker.path!), 'utf8')).toBe('// checker')
    })
})
