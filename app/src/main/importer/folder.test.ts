import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultProblem } from '../../shared/problem'
import { analyzeProblemFiles, applyFolder, detectForSource, previewFolder } from './folder'
import { loadProblem, patchProblem, problemDir, readTests, saveProblem } from '../problem/store'
import type { ProblemFolderPreview } from '../../shared/importer'
import { registerMode, unregisterSource } from '../judge/modes/registry'

let dir: string
beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-folder-test-'))
    vi.stubEnv('ITER_STORE', path.join(dir, '.store'))
})
afterEach(async () => {
    vi.unstubAllEnvs()
    if (path.dirname(dir) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('iter-folder-test-'))
        throw new Error('Invalid fixture cleanup path')
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 })
})
async function tree(files: Record<string, string>): Promise<void> {
    for (const [file, content] of Object.entries(files)) {
        const target = path.join(dir, file)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, content)
    }
}

describe('pure problem-folder analysis', () => {
    it('pairs mixed OI data and keeps arbitrary user solution names', () => {
        const files = [
            'necklace4.in',
            'necklace4.out',
            'necklace1.in',
            'necklace1.ans',
            'necklace1.out',
            'ex_segment1.in',
            'ex_segment1.ans',
            'T2.cpp',
            'untitled1.cpp',
            '未命名1.cpp',
            'std.cpp',
            'solution.cpp',
            'checker.cpp',
            'interactor.cpp',
            'validator.cpp',
            'generator.cpp',
            'grader.cpp',
            'perm.h',
            'template_perm.cpp',
            'perm_template_old.cpp',
            'untitled1.exe',
            'problem.pdf',
            '.hidden.in',
            '.cph/x.in'
        ]
        const code = Object.fromEntries(
            files.filter((file) => /\.cpp$/i.test(file)).map((file) => [file, '#include "perm.h"\nvoid perm() {}'])
        )
        const problem = analyzeProblemFiles(path.join(dir, 'necklace'), files, code)!
        expect(problem.name).toBe('necklace')
        expect(problem.sources.map((file) => path.basename(file))).toEqual([
            'T2.cpp',
            'untitled1.cpp',
            '未命名1.cpp',
            'solution.cpp',
            'std.cpp'
        ])
        expect(problem.pairs.map((pair) => path.basename(pair.answer!))).toEqual([
            'ex_segment1.ans',
            'necklace1.ans',
            'necklace4.out'
        ])
        expect(problem.template).toBe(path.join(dir, 'necklace', 'perm_template_old.cpp'))
        expect(problem.checker).toBe(path.join(dir, 'necklace', 'checker.cpp'))
        expect(problem.interactor).toBe(path.join(dir, 'necklace', 'interactor.cpp'))
        expect(problem.grader).toEqual({
            sources: [path.join(dir, 'necklace', 'grader.cpp')],
            headers: [path.join(dir, 'necklace', 'perm.h')]
        })
        expect(problem.notes.some((note) => note.includes('函数式评测'))).toBe(true)
    })

    it('finds a grader with main alongside the template header, excluding comment/string false positives', () => {
        const problem = analyzeProblemFiles(
            dir,
            ['perm1.in', 'perm1.out', 'perm.h', 'template_perm.cpp', 'driver.cpp', 'fake.cpp', 'T2.cpp'],
            {
                'template_perm.cpp': '#include "perm.h"\nvoid perm() {}',
                'perm.h': 'void perm();',
                'driver.cpp': 'extern void perm();\nint main() { perm(); }',
                'fake.cpp': '#include "perm.h"\n// int main() {}\nconst char* x = "int main() {}";',
                'T2.cpp': '#include "perm.h"\nvoid perm() {}'
            }
        )!
        expect(problem.grader?.sources).toEqual([path.join(dir, 'driver.cpp')])
        expect(problem.sources).toEqual([path.join(dir, 'T2.cpp'), path.join(dir, 'fake.cpp')])
        expect(analyzeProblemFiles(dir, ['T2.cpp', 'problem.pdf', 'stray.exe'])).toBeNull()
    })

    it('excludes a scratch main from a grader folder and retains its template when no solution qualifies', () => {
        const problem = analyzeProblemFiles(
            path.join(dir, 'perm'),
            ['perm1.in', 'perm1.ans', 'grader.cpp', 'perm.h', 'template_perm.cpp', '未命名1.cpp', 'helper.cpp'],
            {
                'grader.cpp': '#include "perm.h"\nint main() { return perm(1, 2).size(); }',
                'perm.h':
                    '#include <vector>\nstd::vector<int> perm(int c, int n);\nbool query(std::vector<int>, int, int);',
                'template_perm.cpp': '#include "perm.h"\nstd::vector<int> perm(int c,int n) { return {}; }',
                '未命名1.cpp':
                    'signed main(int argc, char** argv) { int n=17; for(int i=2;i<n;i++) if(n%i==0) return 1; }',
                'helper.cpp': 'int unrelated(int x) { return x; }'
            }
        )!
        expect(problem.sources).toEqual([])
        expect(problem.template).toBe(path.join(dir, 'perm', 'template_perm.cpp'))
        expect(problem.grader?.sources).toEqual([path.join(dir, 'perm', 'grader.cpp')])
        expect(problem.notes).toContain('未命名1.cpp 含 main，不作为解答')
    })

    it('accepts grader solutions by a real header include or a declared function definition', () => {
        const problem = analyzeProblemFiles(
            dir,
            ['1.in', 'grader.cpp', 'perm.h', 'include.cpp', 'function.cpp', 'declaration.cpp', 'fake.cpp'],
            {
                'grader.cpp': 'int main() {}',
                'perm.h': 'int perm(int c, int n);',
                'include.cpp': '#include /* real include */ "./perm.h"\nint helper() { return 0; }',
                'function.cpp': 'int perm(int c, int n) { return n; }',
                'declaration.cpp': 'int perm(int c, int n);',
                'fake.cpp':
                    '// #include "perm.h"\n/* int perm(int c, int n) {} */\nconst char* example = R"example(\n#include "perm.h"\nint perm(int c,int n) {}\n)example";'
            }
        )!
        expect(problem.sources.map((file) => path.basename(file))).toEqual(['function.cpp', 'include.cpp'])
    })

    it('requires a main definition for normal, SPJ and interactive problems, ignoring comments and literals', () => {
        for (const tool of ['', 'checker.cpp', 'interactor.cpp']) {
            const problem = analyzeProblemFiles(
                dir,
                ['1.in', 'T2.cpp', 'normal.cpp', 'helper.cpp', 'prototype.cpp', 'fake.cpp', ...(tool ? [tool] : [])],
                {
                    'T2.cpp': '#define EXAMPLE main() {}\nsigned main(int argc, char** argv) { return 0; }',
                    'normal.cpp': "const int limit = 1'000; int main(int argc, char** argv) noexcept { return 'a'; }",
                    'helper.cpp': 'int helper(int x) { return x; }',
                    'prototype.cpp': 'int main(int, char**);',
                    'fake.cpp':
                        '// int main() {}\n/* signed main(int argc,char** argv) {} */\nconst char* s = "int main() {}";\nconst char* raw = R"tag(he said "hello"; /* comment */ int main() {})tag";'
                }
            )!
            expect(problem.sources.map((file) => path.basename(file))).toEqual(['T2.cpp', 'normal.cpp'])
        }
    })

    it('ranks problem names and task names first, reference solutions lower, then newest files within each rank', () => {
        const files = [
            '1.in',
            'perm.cpp',
            'T1.cpp',
            'T2.cpp',
            'older.cpp',
            'newer.cpp',
            'sol.cpp',
            'std.cpp',
            'brute.cpp',
            'bf.cpp'
        ]
        const code = Object.fromEntries(
            files.filter((file) => file.endsWith('.cpp')).map((file) => [file, 'int main() {}'])
        )
        const problem = analyzeProblemFiles(path.join(dir, 'perm'), files, code, {
            'perm.cpp': 1,
            'T1.cpp': 20,
            'T2.cpp': 30,
            'older.cpp': 100,
            'newer.cpp': 200,
            'sol.cpp': 1000,
            'std.cpp': 2000,
            'brute.cpp': 3000,
            'bf.cpp': 4000
        })!
        expect(problem.sources.map((file) => path.basename(file))).toEqual([
            'perm.cpp',
            'T2.cpp',
            'T1.cpp',
            'newer.cpp',
            'older.cpp',
            'bf.cpp',
            'brute.cpp',
            'std.cpp',
            'sol.cpp'
        ])
    })
})

describe('folder previews and binding', () => {
    it('keeps three auto-bound linked cases when the same folder is dropped again, adding only new inputs', async () => {
        await tree({
            'coin/T2.cpp': 'int main() {}',
            'coin/coin1.in': '1',
            'coin/coin1.ans': '2',
            'coin/coin2.in': '2',
            'coin/coin2.ans': '3',
            'coin/coin3.in': '3',
            'coin/coin3.ans': '4'
        })
        const sourcePath = path.join(dir, 'coin', 'T2.cpp')
        const problem = (await detectForSource(sourcePath))!
        const request = { problem, sourcePath, link: true, replaceTests: false }
        expect(await applyFolder(request)).toEqual({ sourcePath, added: 3 })
        const original = (await loadProblem(sourcePath)).tests
        const dropped = (await previewFolder(path.dirname(sourcePath))).problems[0]
        expect(dropped.boundSource).toBe(sourcePath)
        expect(await applyFolder({ ...request, problem: dropped })).toEqual({ sourcePath, added: 0 })
        expect((await loadProblem(sourcePath)).tests).toEqual(original)
        await tree({ 'coin/coin4.in': '4', 'coin/coin4.ans': '5' })
        expect(
            await applyFolder({ ...request, problem: (await previewFolder(path.dirname(sourcePath))).problems[0] })
        ).toEqual({ sourcePath, added: 1 })
        const appended = (await loadProblem(sourcePath)).tests
        expect(appended).toHaveLength(4)
        expect(appended.slice(0, 3)).toEqual(original)
    })

    it('updates a renamed answer on reimport without losing case metadata or adding a case', async () => {
        await tree({ 'coin/coin1.in': '1', 'coin/coin1.out': '2' })
        const sourcePath = path.join(dir, 'solution.cpp'),
            folder = path.join(dir, 'coin')
        const request = { sourcePath, initialCode: 'int main() {}', link: true, replaceTests: false }
        await applyFolder({ ...request, problem: (await previewFolder(folder)).problems[0] })
        const cfg = await loadProblem(sourcePath),
            id = cfg.tests[0].id
        cfg.tests[0].name = 'user name'
        cfg.tests[0].enabled = false
        cfg.tests[0].timeLimit = 123
        await saveProblem(sourcePath, cfg)
        const answer = path.join(folder, 'coin1.ans')
        await fs.rename(path.join(folder, 'coin1.out'), answer)
        expect(await applyFolder({ ...request, problem: (await previewFolder(folder)).problems[0] })).toEqual({
            sourcePath,
            added: 0
        })
        expect((await loadProblem(sourcePath)).tests).toEqual([
            {
                id,
                name: 'user name',
                enabled: false,
                timeLimit: 123,
                link: { input: path.join(folder, 'coin1.in'), answer }
            }
        ])
        expect((await readTests(sourcePath, 100))[0].answer).toBe('2')
    })

    it('preserves all case IDs when several answer links change in one folder import', async () => {
        await tree({
            'coin/coin1.in': '1',
            'coin/coin1.out': '2',
            'coin/coin2.in': '2',
            'coin/coin2.out': '3',
            'coin/coin3.in': '3',
            'coin/coin3.out': '4'
        })
        const sourcePath = path.join(dir, 'solution.cpp'),
            folder = path.join(dir, 'coin')
        const request = { sourcePath, initialCode: 'int main() {}', link: true, replaceTests: false }
        await applyFolder({ ...request, problem: (await previewFolder(folder)).problems[0] })
        const cfg = await loadProblem(sourcePath)
        for (const [i, test] of cfg.tests.entries()) {
            test.enabled = false
            test.timeLimit = 100 + i
        }
        await saveProblem(sourcePath, cfg)
        for (const i of [1, 2, 3]) await fs.rename(path.join(folder, `coin${i}.out`), path.join(folder, `coin${i}.ans`))
        expect(await applyFolder({ ...request, problem: (await previewFolder(folder)).problems[0] })).toEqual({
            sourcePath,
            added: 0
        })
        expect((await loadProblem(sourcePath)).tests).toEqual(
            cfg.tests.map((test) => ({
                ...test,
                link: { input: test.link!.input, answer: test.link!.answer!.replace(/\.out$/, '.ans') }
            }))
        )
    })

    it('persists serialized detection mode/config even if its plugin is unloaded before applying', async () => {
        const mode = 'storage-unloaded-mode',
            owner = 'storage-folder-test'
        const modeOptions = {
            outputFile: '../submitted.out',
            nested: { enabled: false, values: [0, null, '选项'] },
            empty: {}
        }
        await tree({ 'bot/1.in': '1', 'bot/1.ans': '2', 'bot/checker.cpp': '// checker' })
        registerMode(owner, {
            id: mode,
            name: '自定义检测',
            detect: () => ({ confidence: 1, config: { modeOptions, timeLimit: 234 } }),
            run() {
                throw new Error('This persistence test must not run a judge')
            },
            describe: () => ({ modeId: mode, modeName: '自定义检测', badges: [] })
        })
        try {
            const detected = (await previewFolder(path.join(dir, 'bot'))).problems[0]
            expect(detected.mode).toBe(mode)
            expect(detected.modeConfig).toMatchObject({ mode, modeOptions, timeLimit: 234 })
            const problem: ProblemFolderPreview = JSON.parse(JSON.stringify(detected))
            unregisterSource(owner)
            const sourcePath = path.join(dir, 'solutions', 'plugin.cpp')
            await applyFolder({ problem, sourcePath, initialCode: 'int main() {}', link: true, replaceTests: true })
            expect(await loadProblem(sourcePath)).toMatchObject({
                mode,
                modeOptions,
                timeLimit: 234,
                checker: { kind: 'custom', path: expect.stringMatching(/^resources\//) },
                tests: [{ name: '1' }]
            })
            expect(problem.modeConfig?.modeOptions).toEqual(modeOptions)
        } finally {
            unregisterSource(owner)
        }
    })

    it('retains modeConfig.mode without preview.mode and protects imported cases from detector fields', async () => {
        await tree({ 'bot/1.in': '1', 'bot/checker.cpp': '// checker', 'bot/interactor.cpp': '// interactor' })
        const problem = (await previewFolder(path.join(dir, 'bot'))).problems[0]
        const mode = 'unavailable.from-config',
            modeOptions = { input: './custom/input', nested: [null, false, 0] }
        delete problem.mode
        problem.modeConfig = {
            mode,
            modeOptions,
            title: 'do not copy',
            version: 999,
            tests: [{ id: 'injected' }],
            timeLimit: 345,
            fileIO: { enabled: true, input: 'custom.in', output: 'custom.out' }
        }
        const sourcePath = path.join(dir, 'plugin.cpp')
        await applyFolder({ problem, sourcePath, initialCode: 'int main() {}', link: true, replaceTests: true })
        const cfg = await loadProblem(sourcePath)
        expect(cfg).toMatchObject({
            version: 1,
            title: 'bot',
            mode,
            modeOptions,
            timeLimit: 345,
            fileIO: { enabled: true, input: 'custom.in', output: 'custom.out' }
        })
        expect(cfg.tests.map((test) => test.name)).toEqual(['1'])
        expect(cfg.tests.some((test) => test.id === 'injected')).toBe(false)
    })

    it('classifies contest/problem/none and ignores hidden/metadata directories without writes', async () => {
        await tree({
            'bot/bot1.in': '1',
            'bot/bot1.ans': '1',
            'bot/T2.cpp': 'int main() {}',
            'coin/coin1.in': '2',
            'coin/coin1.out': '2',
            'coin/未命名1.cpp': 'int main() {}',
            '.cph/1.in': '',
            '.iter/1.in': '',
            '__MACOSX/1.in': '',
            '.hidden/1.in': '',
            'empty/problem.pdf': '',
            'empty/stray.exe': ''
        })
        const before = await fs.readdir(dir, { recursive: true })
        expect((await previewFolder(dir)).problems.map((problem) => problem.name)).toEqual(['bot', 'coin'])
        expect((await previewFolder(dir)).kind).toBe('contest')
        expect((await previewFolder(path.join(dir, 'bot'))).kind).toBe('problem')
        expect((await previewFolder(path.join(dir, 'empty'))).kind).toBe('none')
        expect(await fs.readdir(dir, { recursive: true })).toEqual(before)
        await tree({ 'root1.in': '0' })
        expect((await previewFolder(dir)).problems).toHaveLength(1)
        expect((await previewFolder(dir)).kind).toBe('problem')
    })

    it('finds bound sources by linked data, and suggests auto-binding only for an empty user solution', async () => {
        await tree({
            'bot/bot1.in': '1',
            'bot/bot1.ans': '1',
            'bot/T2.cpp': 'int main() {}',
            'bot/untitled1.cpp': 'signed main() {}',
            'bot/checker.cpp': ''
        })
        const sourcePath = path.join(dir, 'bot', 'T2.cpp')
        expect((await detectForSource(sourcePath))?.name).toBe('bot')
        if (process.platform === 'win32')
            expect((await detectForSource(sourcePath.toUpperCase()))?.name.toLowerCase()).toBe('bot')
        expect(await detectForSource(path.join(dir, 'bot', 'checker.cpp'))).toBeNull()
        const config = defaultProblem('T2')
        config.tests.push({ id: 'one', name: 'one', enabled: true, link: { input: 'bot1.in', answer: 'bot1.ans' } })
        await tree({ 'bot/.iter/T2/problem.json': JSON.stringify(config) })
        const before = await fs.readdir(dir, { recursive: true })
        expect((await previewFolder(path.dirname(sourcePath))).problems[0].boundSource).toBe(sourcePath)
        expect(await detectForSource(sourcePath)).toBeNull()
        expect((await detectForSource(path.join(dir, 'bot', 'untitled1.cpp')))?.boundSource).toBe(sourcePath)
        expect(await fs.readdir(dir, { recursive: true })).toEqual(before)
    })

    it('uses filesystem modification times and moves a qualified bound solution ahead of the problem name', async () => {
        await tree({
            'bot/bot1.in': '1',
            'bot/bot1.ans': '1',
            'bot/bot.cpp': 'int main() {}',
            'bot/old.cpp': 'int main() {}',
            'bot/recent.cpp': 'int main() {}'
        })
        await fs.utimes(path.join(dir, 'bot', 'old.cpp'), 1000, 1000)
        await fs.utimes(path.join(dir, 'bot', 'recent.cpp'), 2000, 2000)
        const folder = path.join(dir, 'bot')
        expect((await previewFolder(folder)).problems[0].sources.map((file) => path.basename(file))).toEqual([
            'bot.cpp',
            'recent.cpp',
            'old.cpp'
        ])
        const config = defaultProblem('old')
        config.tests.push({ id: 'one', name: 'one', enabled: true, link: { input: 'bot1.in', answer: 'bot1.ans' } })
        await tree({ 'bot/.iter/old/problem.json': JSON.stringify(config) })
        const problem = (await previewFolder(folder)).problems[0]
        expect(problem.boundSource).toBe(path.join(folder, 'old.cpp'))
        expect(problem.sources.map((file) => path.basename(file))).toEqual(['old.cpp', 'bot.cpp', 'recent.cpp'])
    })

    it('creates initial code, copies bytes in copy mode, appends and replaces linked tests safely', async () => {
        await tree({ 'bot/bot1.in': '汉🙂\r\n', 'bot/bot1.ans': 'answer\r\n' })
        const problem = (await previewFolder(path.join(dir, 'bot'))).problems[0]
        const sourcePath = path.join(dir, 'solutions', 'T2.cpp')
        const request = { problem, sourcePath, initialCode: 'int main() {}', link: false, replaceTests: false }
        expect(await applyFolder(request)).toEqual({ sourcePath, added: 1 })
        expect(await fs.readFile(sourcePath, 'utf8')).toBe(request.initialCode)
        let config = await loadProblem(sourcePath)
        expect(config.title).toBe('bot')
        expect(config.fileIO).toEqual({ enabled: false, input: 'bot.in', output: 'bot.out' })
        expect(config.tests[0].link).toBeUndefined()
        expect((await readTests(sourcePath, 100))[0].input).toBe('汉🙂\r\n')
        await applyFolder({ ...request, initialCode: 'must not overwrite', link: true })
        expect((await loadProblem(sourcePath)).tests).toHaveLength(2)
        await applyFolder({ ...request, link: true, replaceTests: true })
        config = await loadProblem(sourcePath)
        expect(config.tests).toHaveLength(1)
        expect(config.tests[0].link).toEqual({
            input: path.join(dir, 'bot', 'bot1.in'),
            answer: path.join(dir, 'bot', 'bot1.ans')
        })
        expect(await fs.readdir(path.join(problemDir(sourcePath), 'tests'))).toHaveLength(2)
        expect(await fs.readFile(path.join(dir, 'bot', 'bot1.in'), 'utf8')).toBe('汉🙂\r\n')
        expect(await fs.readFile(sourcePath, 'utf8')).toBe(request.initialCode)
    })

    it('validates missing data before replacing tests or creating a source', async () => {
        await tree({ 'bot/bot1.in': '1' })
        const problem = (await previewFolder(path.join(dir, 'bot'))).problems[0]
        await fs.rm(problem.pairs[0].input)
        const sourcePath = path.join(dir, 'new.cpp')
        await expect(
            applyFolder({ problem, sourcePath, initialCode: '', link: true, replaceTests: true })
        ).rejects.toThrow()
        await expect(fs.access(sourcePath)).rejects.toThrow()
    })

    it('requires initial code for new solutions and preserves interactor precedence', async () => {
        await tree({ 'bot/bot1.in': '1', 'bot/checker.cpp': '// checker', 'bot/interactor.cpp': '// interactor' })
        const problem = (await previewFolder(path.join(dir, 'bot'))).problems[0]
        const sourcePath = path.join(dir, 'main.cpp')
        await expect(applyFolder({ problem, sourcePath, link: true, replaceTests: true })).rejects.toThrow(
            'Initial code is required'
        )
        await expect(fs.access(sourcePath)).rejects.toThrow()
        await applyFolder({ problem, sourcePath, initialCode: 'int main() {}', link: true, replaceTests: true })
        expect(await loadProblem(sourcePath)).toMatchObject({
            mode: 'interactive',
            checker: { path: expect.stringMatching(/^resources\//) },
            interactor: { path: expect.stringMatching(/^resources\//) }
        })
        await fs.rm(path.join(dir, 'bot'), { recursive: true })
        const switched = await patchProblem(sourcePath, { mode: 'spj' })
        expect(await fs.readFile(path.join(problemDir(sourcePath), switched.checker.path!), 'utf8')).toBe('// checker')
    })
})
