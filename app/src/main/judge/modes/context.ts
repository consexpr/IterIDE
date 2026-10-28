import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CompileResult, ToolchainSettings } from '../../../shared/judge'
import { problemDir, testDataPaths } from '../../problem/store'
import { compileSource } from '../compile'
import { prepareTool } from '../checkers'
import { buildPlanFor } from '../flags'
import { execute } from '../process'
import { getPassthroughRunner, getRunner } from '../runner'
import { runTest } from '../run'
import type { ModeCompileContext, ModeProblem, ModeRunContext } from './registry'
import { holdCachePath } from '../cache-lru'

export async function createModeContext(
    sourcePath: string,
    source: string,
    problem: ModeProblem,
    toolchain: ToolchainSettings,
    debug: boolean,
    signal: AbortSignal
) {
    sourcePath = path.resolve(sourcePath)
    const plan = await buildPlanFor(sourcePath, problem)
    const directories: string[] = []
    const leases: (() => void)[] = []
    const retain = <T extends { exe?: string }>(result: T): T => {
        if (result.exe) leases.push(holdCachePath(result.exe))
        return result
    }
    const context: ModeCompileContext = {
        sourcePath,
        sourceDir: path.dirname(sourcePath),
        problemDir: problemDir(sourcePath),
        problem,
        source,
        debug,
        toolchain,
        signal,
        compile: async () =>
            retain(
                await compileSource(
                    sourcePath,
                    source,
                    toolchain,
                    debug,
                    problem.extraFlags,
                    signal,
                    [],
                    undefined,
                    plan
                )
            ),
        prepareTool: async (file, relativeTo, files) => {
            const exe = await prepareTool(
                relativeTo === 'source' ? path.dirname(sourcePath) : problemDir(sourcePath),
                file,
                toolchain,
                signal,
                files
            )
            leases.push(holdCachePath(exe))
            return exe
        },
        runner: () => getRunner(toolchain, signal),
        execute: async (exe, args, options) =>
            execute(exe, args, {
                timeout: 10_000,
                outputLimit: toolchain.outputLimitBytes,
                displayLimit: toolchain.displayLimitChars,
                ...options,
                nativeJob: false,
                signal,
                runner: await getPassthroughRunner(toolchain, signal)
            }),
        tempDir: async () => {
            const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-mode-'))
            directories.push(dir)
            return dir
        }
    }
    return {
        context,
        forTest(test: ModeRunContext['test'], compiled: CompileResult, prepared: unknown): ModeRunContext {
            // Built-in runner still takes the pre-existing ProblemConfig shape; it never selects a mode.
            const options = {
                src: sourcePath,
                exe: compiled.exe ?? '',
                cfg: problem as Parameters<typeof runTest>[0]['cfg'],
                test,
                tc: toolchain,
                signal
            }
            return {
                ...context,
                test,
                compiled,
                prepared,
                dataPaths: testDataPaths(sourcePath, test),
                runShared: async (extra) => {
                    if (!compiled.exe) throw new Error('This mode requires a compiled solution executable')
                    const runner = extra && 'runner' in extra ? extra.runner : await getRunner(toolchain, signal)
                    return runTest({ ...options, ...extra, runner })
                },
                runInteractive: async (interactor) => {
                    if (!compiled.exe) throw new Error('Interactive mode requires a compiled solution executable')
                    if (!interactor) throw new Error('Interactor is not configured')
                    return runTest({ ...options, interactor })
                }
            }
        },
        async dispose(): Promise<void> {
            try {
                await Promise.all(
                    directories.map((dir) =>
                        fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
                    )
                )
            } finally {
                for (const release of leases.splice(0)) release()
            }
        }
    }
}
