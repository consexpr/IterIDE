import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { TestResult, ToolchainSettings, Verdict } from '../../shared/judge'
import type { ProblemConfig, TestCaseMeta } from '../../shared/problem'
import { testDataPaths } from '../problem/store'
import { previewFile } from '../problem/files'
import { builtinCheck, customCheck } from './checkers'
import { execute } from './process'
import { getPassthroughRunner, readAccounting } from './runner'
import { runInteractive } from './interactive'

function scratchPath(scratch: string, name: string): string {
    const target = path.resolve(scratch, name)
    const relative = path.relative(scratch, target)
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
        throw new Error(`File-IO name must stay inside the test directory: ${name}`)
    return target
}

export async function runTest(options: {
    src: string
    exe: string
    cfg: ProblemConfig
    test: TestCaseMeta
    tc: ToolchainSettings
    runner?: string
    checker?: string
    interactor?: string
    signal: AbortSignal
}): Promise<TestResult> {
    const { cfg, test, tc, signal } = options
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-test-'))
    const original = testDataPaths(options.src, test)
    const timeLimit = test.timeLimit ?? cfg.timeLimit
    try {
        const internal = await fs.mkdtemp(path.join(scratch, '.iter-'))
        const input = path.join(internal, 'case.in'),
            answer = path.join(internal, 'case.ans'),
            outputFile = path.join(internal, 'program.out')
        await fs.copyFile(original.input, input)
        if (original.answer === undefined || (test.compareOutput === false && !options.interactor))
            await fs.writeFile(answer, '')
        else
            await fs.copyFile(original.answer, answer).catch(async (e: NodeJS.ErrnoException) => {
                if (e.code !== 'ENOENT') throw e
                await fs.writeFile(answer, '')
            })
        if (options.interactor) {
            const result = await runInteractive({
                ...options,
                interactor: options.interactor,
                args: cfg.interactor?.args,
                scratch,
                testId: test.id,
                input,
                output: outputFile,
                answer,
                timeLimit
            })
            // Interactors still drive the protocol and may reject it. Only a successful
            // conversation can become an un-compared run; never hide its failures.
            if (result.verdict === 'AC' && (test.compareOutput === false || (await fs.stat(answer)).size === 0))
                result.verdict = 'NA'
            return result
        }
        let fileOutput: string | undefined
        if (cfg.fileIO.enabled) {
            const target = scratchPath(scratch, cfg.fileIO.input)
            fileOutput = scratchPath(scratch, cfg.fileIO.output)
            if (target === fileOutput) throw new Error('File-IO input and output must have different names')
            await fs.mkdir(path.dirname(target), { recursive: true })
            await fs.mkdir(path.dirname(fileOutput), { recursive: true })
            await fs.copyFile(input, target)
        }
        const overFileLimit = async (): Promise<boolean> =>
            fileOutput ? ((await fs.stat(fileOutput).catch(() => undefined))?.size ?? 0) > tc.outputLimitBytes : false
        const fallback = async () =>
            execute(options.exe, [], {
                runner: await getPassthroughRunner(tc, signal),
                cwd: scratch,
                timeout: timeLimit + Math.max(100, timeLimit * 0.15),
                signal,
                input,
                output: outputFile,
                outputLimit: tc.outputLimitBytes,
                displayLimit: tc.displayLimitChars,
                poll: fileOutput ? overFileLimit : undefined
            })
        let result = options.runner
            ? await execute(
                  options.runner,
                  [path.join(internal, 'result.json'), String(timeLimit), String(cfg.memoryLimit), options.exe],
                  {
                      nativeJob: true,
                      cwd: scratch,
                      timeout: timeLimit + Math.max(100, timeLimit * 0.15) + (options.runner ? 500 : 0),
                      signal,
                      input,
                      output: outputFile,
                      outputLimit: tc.outputLimitBytes,
                      displayLimit: tc.displayLimitChars,
                      poll: fileOutput ? overFileLimit : undefined
                  }
              )
            : await fallback()
        let accounting = options.runner ? await readAccounting(internal) : undefined
        // Job Objects / resource setup can be unavailable even when the helper built.
        let usedRunner = !!options.runner
        if (usedRunner && !accounting && result.code === 125 && !signal.aborted && !result.timedOut) {
            usedRunner = false
            result = await fallback()
            accounting = undefined
        }
        let verdict: Verdict | undefined, checkerMessage: string | undefined
        const exitCode = accounting?.exitCode ?? result.code
        const nativeSignal = accounting?.signal
            ? (Object.entries(os.constants.signals).find(([, number]) => number === accounting.signal)?.[0] ??
              `SIG${accounting.signal}`)
            : result.signal
        let timeMs = accounting?.timeMs ?? result.timeMs
        if (signal.aborted) {
            verdict = 'SE'
            checkerMessage = 'Stopped'
        } else if (result.outputExceeded || (await overFileLimit())) verdict = 'OLE'
        else if (
            result.timedOut ||
            accounting?.status === 'time_limit' ||
            (accounting ? accounting.timeMs > timeLimit || accounting.wallMs > timeLimit : result.timeMs > timeLimit)
        ) {
            verdict = 'TLE'
            const wallTimedOut = result.timedOut || accounting?.wallTimedOut
            // A wall-clock kill must not be displayed as a tiny CPU time. Preserve CPU
            // timing for successful runs, but show the elapsed deadline for wall TLEs.
            const wallMs = result.timedOut ? result.timeMs : (accounting?.wallMs ?? result.timeMs)
            timeMs = Math.max(timeLimit, timeMs, wallTimedOut ? wallMs : 0)
            if (wallTimedOut && accounting && accounting.timeMs < timeLimit * 0.5)
                checkerMessage = '等待输入超时（程序可能还在读取输入）'
        } else if (
            accounting?.status === 'memory_limit' ||
            (accounting &&
                (exitCode !== 0 || accounting.signal !== 0) &&
                /bad_alloc|cannot allocate memory|out of memory/i.test(result.stderr))
        )
            verdict = 'MLE'
        else if (result.error || (usedRunner && !accounting)) {
            verdict = 'SE'
            checkerMessage = result.error ?? 'Native runner failed to produce accounting data'
        } else if (exitCode !== 0 || nativeSignal) {
            verdict = 'RE'
            checkerMessage = `Program exited with ${nativeSignal ?? exitCode}`
        }

        let selectedOutput = outputFile
        let missingOutput = false
        if (fileOutput) {
            selectedOutput = fileOutput
            missingOutput = !(await fs.stat(fileOutput).catch(() => undefined))?.isFile()
            if (!verdict && missingOutput && test.compareOutput !== false) {
                verdict = 'WA'
                checkerMessage = `output file ${cfg.fileIO.output} not produced`
            }
        }
        const preview = missingOutput
            ? { text: '', truncated: false }
            : await previewFile(selectedOutput, tc.displayLimitChars)
        if (!verdict) {
            if (test.compareOutput === false || (await fs.stat(answer)).size === 0) verdict = 'NA'
            else {
                const checked = options.checker
                    ? await customCheck(
                          options.checker,
                          cfg.checker,
                          { input, output: selectedOutput, answer, score: path.join(scratch, 'score') },
                          tc,
                          signal
                      )
                    : await builtinCheck(selectedOutput, answer, cfg.checker.builtin, signal, cfg.checker.value)
                verdict = checked.verdict
                checkerMessage = checked.checkerMessage
            }
        }
        const combinedStderr =
            fileOutput && result.stdout ? `[stdout]\n${result.stdout}\n[stderr]\n${result.stderr}` : result.stderr
        return {
            testId: test.id,
            verdict,
            timeMs,
            memoryKb: accounting?.memoryKb,
            exitCode,
            signal: nativeSignal,
            output: preview.text,
            stderr: combinedStderr.slice(0, tc.displayLimitChars),
            checkerMessage,
            truncated: result.truncated || preview.truncated || combinedStderr.length > tc.displayLimitChars
        }
    } finally {
        await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
    }
}
