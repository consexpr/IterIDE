import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultProblem } from '../../../shared/problem'
import type { JudgeEvent, ToolchainSettings } from '../../../shared/judge'
import { JudgeEngine } from '../engine'
import { builtinCheck } from '../checkers'
import { compileArgsFor } from '../flags'
import { analyzeProblemFiles, applyFolder } from '../../importer/folder'
import * as store from '../../problem/store'
import { buildDebug, removeBuild } from '../../debug/build'
import {
    detectModes,
    getMode,
    listModes,
    modeIdFor,
    registerMode,
    unregisterSource,
    type JudgeModePlugin,
    type ModeProblem
} from './registry'

const tc: ToolchainSettings = {
    compiler: 'g++',
    flags: '-std=c++17 -O2',
    debugFlags: '-std=c++17 -g -O0',
    gdb: 'gdb',
    clangd: 'clangd',
    clangFormat: 'clang-format',
    parallel: 3,
    outputLimitBytes: 1024,
    displayLimitChars: 1000
}
let dir: string, src: string, engine: JudgeEngine, events: JudgeEvent[]
beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-mode-test-'))
    src = path.join(dir, 'solution.cpp')
    events = []
    engine = new JudgeEngine(
        () => tc,
        (e) => events.push(e)
    )
})
afterEach(async () => {
    await engine.stop()
    unregisterSource('test-plugin')
    vi.restoreAllMocks()
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 })
})
async function finish(source = '') {
    const config = await store.loadProblem(src)
    for (const test of config.tests) {
        if (!test.link) continue
        const cached = store.testFilePaths(src, test.id)
        await fs.mkdir(path.dirname(cached.input), { recursive: true })
        await fs.copyFile(path.resolve(path.dirname(src), test.link.input), cached.input)
        if (test.link.answer) await fs.copyFile(path.resolve(path.dirname(src), test.link.answer), cached.answer)
    }
    const id = await engine.run({ sourcePath: src, source })
    await vi.waitFor(() => expect(events.some((e) => e.runId === id && e.type === 'done')).toBe(true), {
        timeout: 10_000
    })
    return events.filter((e) => e.runId === id)
}
// Exercise the engine against its store boundary. The store owner's normalizer must retain mode ids;
// these tests intentionally do not duplicate or patch that out-of-scope persistence implementation.
function useProblem(problem: ModeProblem) {
    vi.spyOn(store, 'loadProblem').mockResolvedValue(problem as Awaited<ReturnType<typeof store.loadProblem>>)
}

describe('runtime judge mode plugins', () => {
    it('detects, builds, prepares, judges and unloads an output-only plain object without a C++ executable', async () => {
        let preparedDir = '',
            compileCalls = 0,
            prepareCalls = 0
        const plugin: JudgeModePlugin = {
            id: 'test-output-only',
            name: '提交答案',
            description: '测试插件',
            parallel: false,
            settingsSchema: [{ key: 'modeOptions.outputFile', label: '答案文件', type: 'file' }],
            detect(folder) {
                const output = folder.files.find((file) => file === 'submitted.out')
                return output
                    ? { confidence: 1, config: { modeOptions: { outputFile: output } }, notes: ['提交答案题'] }
                    : undefined
            },
            build: () => ({ flags: ['-DPLUGIN_MODE=1'], includeDirs: ['headers'] }),
            compile(ctx) {
                compileCalls++
                expect(ctx.source).toBe('unsaved')
                return { ok: true, output: '', diagnostics: [], timeMs: 0, cached: false }
            },
            async prepare(ctx) {
                prepareCalls++
                preparedDir = await ctx.tempDir()
                return { file: path.resolve(ctx.sourceDir, String(ctx.problem.modeOptions!.outputFile)) }
            },
            async run(ctx) {
                const output = (ctx.prepared as { file: string }).file
                const checked = await builtinCheck(output, ctx.dataPaths.answer!, 'tokens', ctx.signal)
                return {
                    ...checked,
                    testId: ctx.test.id,
                    timeMs: 0,
                    exitCode: null,
                    output: await fs.readFile(output, 'utf8'),
                    stderr: ''
                }
            },
            describe: () => ({
                modeId: 'test-output-only',
                modeName: '提交答案',
                badges: [{ label: '提交', value: 'submitted.out' }]
            })
        }
        registerMode('test-plugin', plugin)
        expect(await engine.modes()).toContainEqual({
            id: plugin.id,
            name: plugin.name,
            source: 'test-plugin',
            description: '测试插件'
        })
        const preview = analyzeProblemFiles(dir, ['1.in', '1.ans', 'submitted.out'])!
        expect(preview.mode).toBe(plugin.id)
        expect(preview.modeConfig).toMatchObject({ modeOptions: { outputFile: 'submitted.out' } })
        await fs.writeFile(path.join(dir, 'submitted.out'), '42\n')
        await fs.writeFile(path.join(dir, '1.in'), '')
        await fs.writeFile(path.join(dir, '1.ans'), '42')
        useProblem({
            ...defaultProblem('output'),
            ...preview.modeConfig,
            mode: plugin.id,
            tests: [{ id: '1', name: '1', enabled: true, link: { input: '1.in', answer: '1.ans' } }]
        })
        expect(await engine.describe(src)).toMatchObject({ modeId: plugin.id, modeName: '提交答案' })
        expect(await compileArgsFor(src, tc.flags)).toEqual([
            '-std=c++17',
            '-O2',
            '-DPLUGIN_MODE=1',
            '-I',
            dir,
            '-I',
            path.join(dir, 'headers')
        ])
        const run = await finish('unsaved')
        expect(run.find((e) => e.type === 'test-done')).toMatchObject({
            result: { testId: '1', verdict: 'AC', output: '42\n' }
        })
        expect(run.at(-1)).toMatchObject({ type: 'done', summary: { total: 1, passed: 1, verdict: 'AC' } })
        await vi.waitFor(async () => expect(await fs.stat(preparedDir).catch(() => undefined)).toBeUndefined())
        expect([compileCalls, prepareCalls]).toEqual([1, 1])
        unregisterSource('test-plugin')
        expect(listModes().some((mode) => mode.id === plugin.id)).toBe(false)
        expect(await engine.describe(src)).toMatchObject({
            modeId: plugin.id,
            badges: [expect.objectContaining({ tone: 'error', detail: expect.stringContaining('未安装') })]
        })
        expect((await finish()).at(-1)).toMatchObject({ type: 'done', summary: { verdict: 'SE' } })
        expect(events.find((e) => e.type === 'compile-done' && !e.result.ok)).toMatchObject({
            result: { output: expect.stringContaining(plugin.id) }
        })
    })

    it('rejects collisions and malformed objects, and preserves the built-ins on plugin unload', () => {
        const standard = getMode(defaultProblem('normal'))
        expect(() => registerMode('test-plugin', standard)).toThrow('already registered')
        expect(() => registerMode('test-plugin', { id: 'bad', name: 'Bad' } as JudgeModePlugin)).toThrow('detect')
        expect(() => registerMode('test-plugin', { ...standard, id: undefined } as unknown as JudgeModePlugin)).toThrow(
            'Invalid judge mode'
        )
        unregisterSource('builtin')
        expect(listModes().map((mode) => mode.id)).toEqual(['standard', 'spj', 'interactive', 'grader'])
        expect(() => detectModes({ dir, files: [], peek: () => undefined })).not.toThrow()
    })

    it('maps legacy grader configs and reports missing files and mixed data sources', async () => {
        const problem: ModeProblem = {
            ...defaultProblem('perm'),
            grader: { sources: ['grader.cpp'], includeDirs: ['include'] },
            tests: [
                { id: '1', name: '1', enabled: true, link: { input: 'bot/1.in' } },
                { id: '2', name: '2', enabled: true }
            ]
        }
        useProblem(problem)
        expect(modeIdFor(problem)).toBe('grader')
        const info = await engine.describe(src)
        expect(info.modeId).toBe('grader')
        expect(info.badges).toContainEqual(
            expect.objectContaining({ label: 'Grader', file: path.join(dir, 'grader.cpp'), tone: 'error' })
        )
        expect(info.badges).toContainEqual(expect.objectContaining({ label: '数据', value: '缓存 2 组' }))
    })

    it('uses the same grader/interactive header directories and flags for compilation and syntax checks', async () => {
        await fs.mkdir(path.join(dir, 'include'))
        await fs.mkdir(path.join(dir, 'tools'))
        await fs.writeFile(path.join(dir, 'include', 'perm.h'), '#define VALUE 17\nvoid solve();')
        await fs.writeFile(path.join(dir, 'driver.cpp'), '#include "perm.h"\nint main(){solve();}')
        const problem: ModeProblem = {
            ...defaultProblem('perm'),
            mode: 'interactive',
            extraFlags: '-DEXTRA=1',
            grader: { sources: ['driver.cpp'], includeDirs: ['include'] },
            interactor: { path: 'tools/interactor.cpp', relativeTo: 'source' }
        }
        useProblem(problem)
        const args = await compileArgsFor(src, '-std=c++20 -O2')
        expect(args).toEqual(
            expect.arrayContaining(['-std=c++20', '-DEXTRA=1', path.join(dir, 'include'), path.join(dir, 'tools')])
        )
        const source =
            '#include "perm.h"\n#ifndef EXTRA\n#error missing flag\n#endif\nvoid solve(){ static_assert(VALUE == 17); }'
        expect(await engine.syntaxCheck(src, source)).toEqual([])
        expect(await engine.compile(src, source, false)).toMatchObject({ ok: true })
        expect(await engine.compile(src, source, false)).toMatchObject({ ok: true, cached: true })
        await fs.writeFile(path.join(dir, 'include', 'perm.h'), '#define VALUE 18\nvoid solve();')
        expect(await engine.compile(src, source, false)).toMatchObject({ ok: false, cached: false })
    }, 20_000)

    it('preserves plugin settings and imported cases when applying a folder outside the solution directory', async () => {
        vi.stubEnv('ITER_STORE', path.join(dir, '.store'))
        try {
            const sourcePath = path.join(dir, 'solutions', 'new.cpp')
            await fs.mkdir(path.dirname(sourcePath))
            await fs.writeFile(sourcePath, '// existing solution')
            await fs.writeFile(path.join(dir, '1.in'), '')
            await fs.writeFile(path.join(dir, '1.ans'), '42')
            const existingId = await store.writeTest(sourcePath, {
                name: 'existing',
                input: 'old input',
                answer: 'old answer'
            })
            await store.updateTestMeta(sourcePath, existingId, { enabled: false, timeLimit: 345 })
            const modeOptions = { example: 1, zero: 0, enabled: false, nested: { values: [null, 'answer'] } }
            const request = {
                sourcePath,
                initialCode: 'must not replace existing code',
                replaceTests: false,
                link: true,
                problem: {
                    dir,
                    name: 'new',
                    sources: [],
                    pairs: [{ name: '1', input: path.join(dir, '1.in'), answer: path.join(dir, '1.ans') }],
                    unmatched: [],
                    notes: [],
                    mode: 'test-output-only',
                    modeConfig: {
                        modeOptions,
                        timeLimit: 2345,
                        tests: [],
                        version: 99,
                        title: 'ignored detector title'
                    }
                }
            }
            expect(await applyFolder(request)).toEqual({ sourcePath, added: 1 })
            const saved = await store.loadProblem(sourcePath)
            expect(saved).toMatchObject({
                version: 1,
                title: 'new',
                mode: 'test-output-only',
                timeLimit: 2345,
                modeOptions
            })
            expect(saved.tests).toHaveLength(2)
            expect(saved.tests[0]).toMatchObject({ id: existingId, name: 'existing', enabled: false, timeLimit: 345 })
            expect(saved.tests[1]).toMatchObject({
                name: '1',
                enabled: true,
                link: { input: path.join(dir, '1.in'), answer: path.join(dir, '1.ans') }
            })
            expect(
                (await store.readTests(sourcePath, 100)).map((test) => [test.name, test.input, test.answer])
            ).toEqual([
                ['existing', 'old input', 'old answer'],
                ['1', '', '42']
            ])
            const persisted = JSON.parse(
                await fs.readFile(path.join(store.problemDir(sourcePath), 'problem.json'), 'utf8')
            )
            expect(persisted.modeOptions).toEqual(modeOptions)
            expect(persisted.tests).toEqual(saved.tests)
            expect(await fs.readFile(sourcePath, 'utf8')).toBe('// existing solution')
            // Reimport deduplicates links without dropping the owned case or opaque options.
            expect(await applyFolder(request)).toEqual({ sourcePath, added: 0 })
            expect((await store.loadProblem(sourcePath)).tests).toEqual(saved.tests)
            expect((await store.loadProblem(sourcePath)).modeOptions).toEqual(modeOptions)
        } finally {
            vi.unstubAllEnvs()
        }
    })

    it('compiles a third-party multi-source build plan in both judge and debugger', async () => {
        registerMode('test-plugin', {
            id: 'test-linked',
            name: '插件链接',
            detect: () => undefined,
            build: () => ({ sources: ['helper.cpp'], includeDirs: ['include'], flags: ['-DPLUGIN_VALUE=37'] }),
            run: (ctx) => ctx.runShared(),
            describe: () => ({ modeId: 'test-linked', modeName: '插件链接', badges: [] })
        })
        const problem: ModeProblem = {
            ...defaultProblem('linked'),
            mode: 'test-linked',
            tests: [{ id: '1', name: '1', enabled: true, link: { input: '1.in', answer: '1.ans' } }]
        }
        useProblem(problem)
        await fs.mkdir(path.join(dir, 'include'))
        await fs.writeFile(path.join(dir, 'include', 'helper.h'), 'int value();')
        await fs.writeFile(path.join(dir, 'helper.cpp'), '#include "helper.h"\nint value(){return PLUGIN_VALUE;}')
        await fs.writeFile(path.join(dir, '1.in'), '')
        await fs.writeFile(path.join(dir, '1.ans'), '37')
        const source = '#include "helper.h"\n#include <cstdio>\nint main(){printf("%d", value());}'
        const run = await finish(source)
        expect(run.find((e) => e.type === 'test-done')).toMatchObject({ result: { verdict: 'AC', output: '37' } })
        const debug = await buildDebug({ sourcePath: src, source, breakpoints: [] }, tc, new AbortController().signal)
        try {
            expect((await fs.stat(debug.exe)).isFile()).toBe(true)
        } finally {
            await removeBuild(debug.dir)
        }
    }, 20_000)
})
