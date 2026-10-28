import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { CompileResult, ToolchainSettings } from '../../shared/judge'
import type { TerminalRunRequest, TerminalRunResult } from '../../shared/terminal'
import { acquireProblemLease, loadProblem } from '../problem/store'
import { holdCachePath } from '../judge/cache-lru'
import { compileSource } from '../judge/compile'
import { buildPlanFor } from '../judge/flags'
import { buildTerminalHost, launchTerminalHost, type TerminalHost, type TerminalView } from './host'

const failed = (output: string): CompileResult => ({ ok: false, output, diagnostics: [], timeMs: 0, cached: false })
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))
interface Operation {
    controller: AbortController
    done: Promise<TerminalRunResult>
    closed?: Promise<void>
}

/** One operation owns compilation, its console window, and an empty working
 * directory. No test input, file-IO setting, or neighbouring data is copied in. */
export class TerminalManager {
    private readonly runs = new Map<string, Operation>()
    private disposed = false
    private disposing?: Promise<void>

    constructor(
        private readonly toolchain: () => ToolchainSettings,
        private readonly runtimeRoot: string,
        private readonly openView: (colors: string[]) => Promise<TerminalView>,
        private readonly onExit: (runId: string) => void = () => {},
        private readonly colors: () => string[] = () => []
    ) {}

    run(req: TerminalRunRequest): Promise<TerminalRunResult> {
        if (this.disposed) return Promise.reject(new Error('Terminal manager is disposed'))
        if (
            !req ||
            typeof req.sourcePath !== 'string' ||
            !path.isAbsolute(req.sourcePath) ||
            typeof req.source !== 'string'
        )
            return Promise.reject(new Error('Invalid terminal source'))
        if (
            req.operationId !== undefined &&
            (typeof req.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(req.operationId))
        )
            return Promise.reject(new Error('Invalid terminal operation id'))
        const id = req.operationId ?? randomUUID()
        if (this.runs.has(id)) return Promise.reject(new Error('Terminal operation id is already active'))
        const operation: Operation = { controller: new AbortController(), done: undefined! }
        // Register before work starts, so stop(operationId) also cancels queued builds.
        this.runs.set(id, operation)
        operation.done = Promise.resolve().then(() => this.execute(id, req, operation))
        return operation.done
    }

    async stop(runId?: string): Promise<void> {
        const runs =
            runId === undefined
                ? [...this.runs.values()]
                : [this.runs.get(runId)].filter((value): value is Operation => !!value)
        for (const run of runs) run.controller.abort()
        await Promise.all(
            runs.map(async (run) => {
                await run.done
                await run.closed
            })
        )
    }

    dispose(): Promise<void> {
        if (!this.disposing) {
            this.disposed = true
            this.disposing = this.stop()
        }
        return this.disposing
    }

    private assertStorage(): void {
        if (!path.isAbsolute(this.runtimeRoot)) throw new Error('终端运行目录必须是绝对路径')
    }

    private async execute(id: string, req: TerminalRunRequest, operation: Operation): Promise<TerminalRunResult> {
        const signal = operation.controller.signal
        let compile = failed('编译尚未开始'),
            dir: string | undefined,
            host: TerminalHost | undefined
        const releases: (() => void)[] = []
        let handedOff = false
        const cleanup = async (): Promise<void> => {
            try {
                if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
            } finally {
                for (const release of releases.splice(0)) release()
                if (this.runs.get(id) === operation) this.runs.delete(id)
                this.onExit(id)
            }
        }
        try {
            signal.throwIfAborted()
            if (process.platform !== 'win32') throw new Error('独立终端模式目前支持 Windows')
            this.assertStorage()
            releases.push(await acquireProblemLease(req.sourcePath))
            signal.throwIfAborted()
            const problem = await loadProblem(req.sourcePath),
                settings = { ...this.toolchain() }
            const plan = await buildPlanFor(req.sourcePath, problem)
            signal.throwIfAborted()
            compile = await compileSource(
                req.sourcePath,
                req.source,
                settings,
                false,
                problem.extraFlags,
                signal,
                [],
                undefined,
                plan
            )
            if (compile.exe) releases.push(holdCachePath(compile.exe))
            signal.throwIfAborted()
            if (!compile.ok || !compile.exe) return { runId: id, compile, launched: false }
            await fs.mkdir(this.runtimeRoot, { recursive: true })
            dir = await fs.mkdtemp(path.join(this.runtimeRoot, 'run-'))
            const cwd = path.join(dir, 'work')
            await fs.mkdir(cwd)
            const builtHost = await buildTerminalHost(path.join(this.runtimeRoot, 'host'), settings, signal)
            releases.push(builtHost.release)
            signal.throwIfAborted()
            const view = await this.openView(this.colors())
            try {
                signal.throwIfAborted()
                host = await launchTerminalHost(builtHost.exe, compile.exe, cwd, path.join(dir, 'status'), signal, view)
            } catch (error) {
                view.close()
                throw error
            }
            signal.throwIfAborted()
            operation.closed = host.closed.then(cleanup)
            // A window can close without another IPC call waiting for cleanup.
            // Attach a rejection handler while retaining failures for stop/dispose.
            void operation.closed.catch((error) => console.warn('[iter] terminal cleanup failed:', errorMessage(error)))
            handedOff = true
            return { runId: id, compile, launched: true }
        } catch (error) {
            if (host) {
                host.stop()
                await host.closed
            }
            const cancelled = signal.aborted
            return {
                runId: id,
                compile: !compile.ok && cancelled ? failed('Stopped') : compile,
                launched: false,
                ...(cancelled ? { cancelled: true } : { error: errorMessage(error) })
            }
        } finally {
            if (!handedOff) await cleanup()
        }
    }
}
