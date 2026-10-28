import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { testFilePaths } from '../problem/store'
import { defaultProblem } from '../../shared/problem'
import type { TestResult, ToolchainSettings } from '../../shared/judge'
import { execute, type ProcessResult } from './process'
import { builtinCheck, customCheck } from './checkers'
import { runInteractive } from './interactive'
import { runTest } from './run'
import { prepareShared, runShared } from './modes/builtin/common'
import type { ModeContext, ModeRunContext } from './modes/registry'

vi.mock('./process', () => ({ execute: vi.fn() }))
vi.mock('./checkers', () => ({ builtinCheck: vi.fn(), customCheck: vi.fn() }))
vi.mock('./runner', () => ({
    getPassthroughRunner: vi.fn(),
    readAccounting: vi.fn(async () => ({ timeMs: 1, wallMs: 1, memoryKb: 10, exitCode: 0, signal: 0, status: 'ok' }))
}))
vi.mock('./interactive', () => ({ runInteractive: vi.fn() }))

let directory: string
const tc = { outputLimitBytes: 1024, displayLimitChars: 1024 } as ToolchainSettings
const successful: ProcessResult = {
    code: 0,
    signal: null,
    stdout: 'actual',
    stderr: 'diagnostic',
    timeMs: 1,
    timedOut: false,
    outputExceeded: false,
    truncated: false
}
beforeEach(async () => {
    vi.resetAllMocks()
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-compare-run-'))
    await fs.writeFile(path.join(directory, 'input'), '1')
    await fs.writeFile(path.join(directory, 'answer'), 'expected')
    const cached = testFilePaths(path.join(directory, 'main.cpp'), '1')
    await fs.mkdir(path.dirname(cached.input), { recursive: true })
    await fs.copyFile(path.join(directory, 'input'), cached.input)
    await fs.copyFile(path.join(directory, 'answer'), cached.answer)
    vi.mocked(execute).mockImplementation(async (_exe, _args, options) => {
        await fs.writeFile(options.output!, 'actual')
        return { ...successful }
    })
    vi.mocked(builtinCheck).mockResolvedValue({ verdict: 'WA', checkerMessage: 'mismatch' })
    vi.mocked(customCheck).mockResolvedValue({ verdict: 'WA' })
})
afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5 })
})

function options(compareOutput?: boolean) {
    const cfg = defaultProblem('test')
    const test = {
        id: '1',
        name: '1',
        enabled: true,
        compareOutput,
        link: { input: path.join(directory, 'input'), answer: path.join(directory, 'answer') }
    }
    return {
        src: path.join(directory, 'main.cpp'),
        exe: 'program',
        cfg,
        test,
        tc,
        signal: new AbortController().signal
    }
}

describe('run without output comparison', () => {
    it('preserves the default comparator behavior for old tests', async () => {
        expect(await runTest(options())).toMatchObject({ verdict: 'WA', output: 'actual', stderr: 'diagnostic' })
        expect(builtinCheck).toHaveBeenCalledOnce()
    })
    it.each([undefined, 'custom-checker'])(
        'returns NA with output and stderr and skips comparator %s',
        async (checker) => {
            expect(await runTest({ ...options(false), checker })).toMatchObject({
                verdict: 'NA',
                output: 'actual',
                stderr: 'diagnostic'
            })
            expect(builtinCheck).not.toHaveBeenCalled()
            expect(customCheck).not.toHaveBeenCalled()
            expect(await fs.readFile(path.join(directory, 'answer'), 'utf8')).toBe('expected')
        }
    )
    it.each([
        [{ code: 23 }, 'RE'],
        [{ timedOut: true }, 'TLE'],
        [{ outputExceeded: true }, 'OLE']
    ] as const)('retains execution failure %s', async (failure, verdict) => {
        vi.mocked(execute).mockImplementation(async (_exe, _args, config) => {
            await fs.writeFile(config.output!, 'actual')
            return { ...successful, ...failure }
        })
        expect(await runTest(options(false))).toMatchObject({ verdict, output: 'actual', stderr: 'diagnostic' })
    })
    it.each(['AC', 'WA', 'RE', 'TLE'] as const)(
        'still runs the interactor and preserves protocol verdict %s',
        async (verdict) => {
            vi.mocked(runInteractive).mockResolvedValue({
                testId: '1',
                verdict,
                timeMs: 1,
                exitCode: 0,
                output: 'conversation',
                stderr: ''
            })
            expect(await runTest({ ...options(false), interactor: 'interactor' })).toMatchObject({
                verdict: verdict === 'AC' ? 'NA' : verdict
            })
            expect(runInteractive).toHaveBeenCalledOnce()
            expect(execute).not.toHaveBeenCalled()
        }
    )
    it('does not build a missing SPJ for a run-only selected case, then prepares it only once when comparison resumes', async () => {
        const problem = { ...defaultProblem('test'), checker: { kind: 'custom' as const, path: 'checker.cpp' } }
        const context = {
            problem,
            runner: vi.fn(async () => undefined),
            prepareTool: vi.fn(async () => 'checker')
        } as unknown as ModeContext
        const prepared = await prepareShared(context, true)
        const run = vi.fn(async () => ({ verdict: 'NA' }) as TestResult)
        const forTest = (compareOutput: boolean) =>
            ({ prepared, test: { compareOutput }, runShared: run }) as unknown as ModeRunContext
        await runShared(forTest(false))
        expect(context.prepareTool).not.toHaveBeenCalled()
        expect(run).toHaveBeenLastCalledWith({ runner: undefined, checker: undefined })
        await Promise.all([runShared(forTest(true)), runShared(forTest(true))])
        expect(context.prepareTool).toHaveBeenCalledOnce()
        expect(run).toHaveBeenLastCalledWith({ runner: undefined, checker: 'checker' })
    })
})
