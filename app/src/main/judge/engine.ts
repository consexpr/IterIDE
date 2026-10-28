import type {
    CompileResult,
    Diagnostic,
    JudgeEvent,
    JudgeRequest,
    TestResult,
    ToolchainSettings
} from '../../shared/judge'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { rewriteResourceIncludes } from '../problem/resources'
import { acquireProblemLease, loadProblem, problemDir } from '../problem/store'
import { checkSyntax } from './compile'
import { compileArgsFor } from './flags'
import { getMode, listModes, modeIdFor } from './modes/registry'
import { createModeContext } from './modes/context'

export class JudgeEngine {
    private readonly runs = new Map<string, { controller: AbortController; done: Promise<void> }>()
    private readonly syntax = new Map<string, AbortController>()
    private readonly operations = new Set<Promise<unknown>>()
    private readonly controllers = new Set<AbortController>()
    private disposed = false
    private disposing?: Promise<void>
    constructor(
        private readonly toolchain: () => ToolchainSettings,
        private readonly emit: (e: JudgeEvent) => void
    ) {}
    private tracked<T>(work: (controller: AbortController) => Promise<T>): Promise<T> {
        if (this.disposed) return Promise.reject(new Error('Judge engine is disposed'))
        const controller = new AbortController()
        this.controllers.add(controller)
        const task = work(controller).finally(() => {
            this.controllers.delete(controller)
            this.operations.delete(task)
        })
        this.operations.add(task)
        return task
    }
    compile(sourcePath: string, source: string, debug: boolean): Promise<CompileResult> {
        return this.tracked((controller) => this.compileOperation(sourcePath, source, debug, controller.signal))
    }
    private async compileOperation(
        sourcePath: string,
        source: string,
        debug: boolean,
        signal: AbortSignal
    ): Promise<CompileResult> {
        let session: Awaited<ReturnType<typeof createModeContext>> | undefined
        let release: (() => void) | undefined
        try {
            release = await acquireProblemLease(sourcePath)
            signal.throwIfAborted()
            const cfg = await loadProblem(sourcePath, undefined, source),
                mode = getMode(cfg)
            session = await createModeContext(sourcePath, source, cfg, { ...this.toolchain() }, debug, signal)
            signal.throwIfAborted()
            return await (mode.compile ? mode.compile(session.context) : session.context.compile())
        } catch (error) {
            return { ok: false, output: errorMessage(error), diagnostics: [], timeMs: 0, cached: false }
        } finally {
            try {
                await session?.dispose()
            } finally {
                release?.()
            }
        }
    }
    async run(req: JudgeRequest): Promise<string> {
        if (this.disposed) throw new Error('Judge engine is disposed')
        if (
            req.operationId !== undefined &&
            (typeof req.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(req.operationId))
        )
            throw new Error('Invalid judge operation id')
        const id = req.operationId ?? randomUUID(),
            controller = new AbortController()
        if (this.runs.has(id)) throw new Error('Judge operation id is already active')
        // Defer events until the caller has received its id and can subscribe.
        const done = new Promise<void>((resolve) => setImmediate(resolve))
            .then(() => this.execute(id, req, controller.signal))
            .finally(() => this.runs.delete(id))
        this.runs.set(id, { controller, done })
        return id
    }
    async stop(runId?: string): Promise<void> {
        const runs = runId ? [this.runs.get(runId)].filter((r) => !!r) : [...this.runs.values()]
        for (const run of runs) run.controller.abort()
        await Promise.all(runs.map((run) => run.done))
    }
    syntaxCheck(sourcePath: string, source: string): Promise<Diagnostic[]> {
        if (this.disposed) return Promise.resolve([])
        return this.tracked((controller) => this.syntaxOperation(sourcePath, source, controller))
    }
    private async syntaxOperation(
        sourcePath: string,
        source: string,
        controller: AbortController
    ): Promise<Diagnostic[]> {
        const key = process.platform === 'win32' ? path.resolve(sourcePath).toLowerCase() : path.resolve(sourcePath)
        this.syntax.get(key)?.abort()
        this.syntax.set(key, controller)
        try {
            const tc = { ...this.toolchain() },
                args = await compileArgsFor(sourcePath, tc.flags)
            if (controller.signal.aborted) return []
            const cfg = await loadProblem(sourcePath)
            const headers = Object.fromEntries(
                Object.entries(cfg.cachedHeaders ?? {}).map(([name, file]) => [
                    name,
                    path.resolve(problemDir(sourcePath), file)
                ])
            )
            return await checkSyntax(sourcePath, rewriteResourceIncludes(source, headers), tc, controller.signal, args)
        } catch (error) {
            return controller.signal.aborted
                ? []
                : [
                      {
                          file: sourcePath,
                          line: 1,
                          column: 1,
                          severity: 'error',
                          message: errorMessage(error),
                          source: 'judge'
                      }
                  ]
        } finally {
            if (this.syntax.get(key) === controller) this.syntax.delete(key)
        }
    }

    private async execute(runId: string, req: JudgeRequest, signal: AbortSignal): Promise<void> {
        let total = 0
        let session: Awaited<ReturnType<typeof createModeContext>> | undefined
        let release: (() => void) | undefined
        try {
            release = await acquireProblemLease(req.sourcePath)
            signal.throwIfAborted()
            const cfg = await loadProblem(req.sourcePath, undefined, req.source)
            const tc = { ...this.toolchain() }
            const tests = cfg.tests.filter((t) => (req.testIds?.length ? req.testIds.includes(t.id) : t.enabled))
            total = tests.length
            this.emit({ type: 'compile-start', runId })
            let mode: ReturnType<typeof getMode>
            try {
                mode = getMode(cfg)
            } catch (error) {
                this.emit({
                    type: 'compile-done',
                    runId,
                    result: { ok: false, output: errorMessage(error), diagnostics: [], timeMs: 0, cached: false }
                })
                throw error
            }
            session = await createModeContext(req.sourcePath, req.source, cfg, tc, false, signal)
            signal.throwIfAborted()
            const result = await (mode.compile ? mode.compile(session.context) : session.context.compile())
            this.emit({ type: 'compile-done', runId, result })
            if (!result.ok) {
                this.emit({ type: 'done', runId, summary: { total, passed: 0, verdict: signal.aborted ? 'SE' : 'CE' } })
                return
            }
            const prepared = await mode.prepare?.(session.context)
            const active = session
            const results: TestResult[] = new Array(tests.length)
            let next = 0
            const worker = async (): Promise<void> => {
                while (next < tests.length && !signal.aborted) {
                    const index = next++,
                        test = tests[index]
                    this.emit({ type: 'test-start', runId, testId: test.id })
                    try {
                        const judged = await mode.run(active.forTest(test, result, prepared))
                        validateResult(judged, test.id)
                        results[index] = judged
                    } catch (error) {
                        results[index] = {
                            testId: test.id,
                            verdict: 'SE',
                            timeMs: 0,
                            exitCode: null,
                            output: '',
                            stderr: '',
                            checkerMessage: errorMessage(error)
                        }
                    }
                    this.emit({ type: 'test-done', runId, result: results[index] })
                }
            }
            const parallel =
                mode.parallel === false ? 1 : Math.max(1, Math.min(tests.length, Math.floor(tc.parallel) || 1))
            await Promise.all(Array.from({ length: parallel }, worker))
            this.emit({
                type: 'done',
                runId,
                summary: {
                    total,
                    passed: results.filter((r) => r?.verdict === 'AC').length,
                    verdict: signal.aborted ? 'SE' : (results.find((r) => r && r.verdict !== 'AC')?.verdict ?? 'AC')
                }
            })
        } catch (error) {
            this.emit({ type: 'error', runId, message: errorMessage(error) })
            this.emit({ type: 'done', runId, summary: { total, passed: 0, verdict: 'SE' } })
        } finally {
            try {
                await session?.dispose()
            } finally {
                release?.()
            }
        }
    }

    dispose(): Promise<void> {
        return (this.disposing ??= (async () => {
            this.disposed = true
            for (const controller of this.controllers) controller.abort()
            for (const controller of this.syntax.values()) controller.abort()
            await Promise.allSettled([this.stop(), ...this.operations])
        })())
    }

    async modes(): Promise<import('../../shared/judgeMode').JudgeModeSummary[]> {
        return listModes()
    }
    async describe(sourcePath: string): Promise<import('../../shared/judgeMode').JudgeModeInfo> {
        const problem = await loadProblem(sourcePath)
        try {
            return await getMode(problem).describe(problem, path.resolve(sourcePath))
        } catch (error) {
            return {
                modeId: modeIdFor(problem),
                modeName: '模式不可用',
                badges: [{ label: '评测模式', value: modeIdFor(problem), tone: 'error', detail: errorMessage(error) }]
            }
        }
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
function validateResult(result: TestResult, id: string): void {
    if (
        !result ||
        result.testId !== id ||
        !['AC', 'WA', 'PE', 'TLE', 'MLE', 'RE', 'OLE', 'CE', 'SE', 'NA'].includes(result.verdict) ||
        !Number.isFinite(result.timeMs) ||
        result.timeMs < 0 ||
        typeof result.output !== 'string' ||
        typeof result.stderr !== 'string' ||
        (result.exitCode !== null && !Number.isFinite(result.exitCode))
    )
        throw new Error('Judge mode returned an invalid TestResult')
}
