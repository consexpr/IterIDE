import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { testFilePaths } from '../problem/store'
import { defaultProblem, type ProblemConfig } from '../../shared/problem'
import type { ToolchainSettings } from '../../shared/judge'
import { runTest } from './run'
import { execute, type ProcessResult } from './process'
import { readAccounting, type Accounting } from './runner'

vi.mock('./process', { spy: true })
vi.mock('./runner', { spy: true })

describe('TLE accounting', () => {
    let dir: string, cfg: ProblemConfig
    const tc = { outputLimitBytes: 1024, displayLimitChars: 1000 } as ToolchainSettings
    const execution: ProcessResult = {
        code: 0,
        signal: null,
        stdout: '',
        stderr: '',
        truncated: false,
        timeMs: 1700,
        timedOut: false,
        outputExceeded: false
    }
    const accounting: Accounting = {
        timeMs: 12,
        wallMs: 1155,
        memoryKb: 1024,
        exitCode: 1,
        signal: 0,
        status: 'time_limit',
        wallTimedOut: true
    }
    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-time-test-'))
        await fs.writeFile(path.join(dir, 'case.in'), '1 2 3')
        const cached = testFilePaths(path.join(dir, 'main.cpp'), 'case')
        await fs.mkdir(path.dirname(cached.input), { recursive: true })
        await fs.copyFile(path.join(dir, 'case.in'), cached.input)
        cfg = defaultProblem('test')
        cfg.tests = [{ id: 'case', name: 'case', enabled: true, link: { input: 'case.in' } }]
        vi.mocked(execute).mockResolvedValue({ ...execution })
        vi.mocked(readAccounting).mockResolvedValue({ ...accounting })
    })
    afterEach(async () => {
        vi.resetAllMocks()
        await fs.rm(dir, { recursive: true, force: true })
    })
    const run = () =>
        runTest({
            src: path.join(dir, 'main.cpp'),
            exe: 'program',
            cfg,
            test: cfg.tests[0],
            tc,
            runner: 'runner',
            signal: new AbortController().signal
        })

    it('shows wall time and the input-wait hint for a native wall guard kill', async () => {
        expect(await run()).toMatchObject({
            verdict: 'TLE',
            timeMs: 1155,
            checkerMessage: '等待输入超时（程序可能还在读取输入）'
        })
    })

    it('uses the outer guard time when the helper has only partial accounting', async () => {
        vi.mocked(execute).mockResolvedValue({ ...execution, timedOut: true })
        vi.mocked(readAccounting).mockResolvedValue({ ...accounting, status: 'ok', wallMs: 50, wallTimedOut: false })
        expect(await run()).toMatchObject({
            verdict: 'TLE',
            timeMs: 1700,
            checkerMessage: '等待输入超时（程序可能还在读取输入）'
        })
    })

    it('reports an outer guard TLE even if the helper cannot write accounting', async () => {
        vi.mocked(execute).mockResolvedValue({ ...execution, timedOut: true })
        vi.mocked(readAccounting).mockResolvedValue(undefined)
        expect(await run()).toMatchObject({ verdict: 'TLE', timeMs: 1700 })
    })

    it('preserves CPU time and omits the input-wait hint for a CPU limit kill', async () => {
        vi.mocked(readAccounting).mockResolvedValue({ ...accounting, timeMs: 1015, wallMs: 1100, wallTimedOut: false })
        expect(await run()).toMatchObject({ verdict: 'TLE', timeMs: 1015, checkerMessage: undefined })
    })

    it('does not blame input when CPU time is close to the limit at a wall kill', async () => {
        vi.mocked(readAccounting).mockResolvedValue({ ...accounting, timeMs: 950 })
        expect(await run()).toMatchObject({ verdict: 'TLE', timeMs: 1155, checkerMessage: undefined })
    })

    it('clamps a native timeout to a per-case limit even with truncated accounting', async () => {
        cfg.tests[0].timeLimit = 2000
        vi.mocked(readAccounting).mockResolvedValue({ ...accounting, wallMs: 1999.9 })
        expect(await run()).toMatchObject({ verdict: 'TLE', timeMs: 2000 })
    })
})
