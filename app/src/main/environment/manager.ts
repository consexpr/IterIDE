import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import type { ToolchainSettings } from '../../shared/judge'
import {
    emptyEnvironmentHealth,
    healthConfig,
    type EnvironmentHealth,
    type HealthCheck,
    type HealthCheckId
} from '../../shared/environment'
import { environmentProbes, type ProbeContext, type ProbeResult } from './probes'

export type EnvironmentProbes = Record<HealthCheckId, (context: ProbeContext) => Promise<ProbeResult>>

/** User-triggered checks have their own files and processes, never the active judge/debugger/LSP. */
export class EnvironmentHealthService {
    private report = emptyEnvironmentHealth()
    private flight?: Promise<EnvironmentHealth>
    private controller?: AbortController
    private disposed = false
    constructor(
        private readonly tools: () => ToolchainSettings,
        private readonly version: string,
        private readonly notify: (state: EnvironmentHealth) => void,
        private readonly probes: EnvironmentProbes = environmentProbes
    ) {}

    state(): EnvironmentHealth {
        return structuredClone(this.report)
    }
    private publish(patch: Partial<EnvironmentHealth>): void {
        this.report = { ...this.report, ...patch, revision: this.report.revision + 1 }
        // A closed renderer must not prevent cleanup of owned test processes.
        try {
            this.notify(this.state())
        } catch {
            /* the result remains available through state() */
        }
    }
    private check(id: HealthCheckId, patch: Partial<HealthCheck>): void {
        this.publish({ checks: this.report.checks.map((check) => (check.id === id ? { ...check, ...patch } : check)) })
    }
    start(): Promise<EnvironmentHealth> {
        if (this.disposed) return Promise.reject(new Error('环境体检已关闭'))
        if (this.flight) return this.flight
        const tools = { ...this.tools() },
            controller = new AbortController()
        this.controller = controller
        this.publish({
            ...emptyEnvironmentHealth(),
            revision: this.report.revision,
            version: this.version,
            platform: `${process.platform} ${process.arch}`,
            status: 'running',
            startedAt: new Date().toISOString(),
            config: healthConfig(tools)
        })
        const work = this.run(tools, controller).finally(() => {
            if (this.flight === work) {
                this.flight = undefined
                this.controller = undefined
            }
        })
        this.flight = work
        return work
    }
    async cancel(): Promise<void> {
        this.controller?.abort()
        await this.flight
    }
    async dispose(): Promise<void> {
        this.disposed = true
        await this.cancel()
    }

    private async run(tools: ToolchainSettings, controller: AbortController): Promise<EnvironmentHealth> {
        const signal = controller.signal
        const parent = path.resolve(os.tmpdir())
        let directory: string | undefined
        const deadline = setTimeout(() => controller.abort(new Error('环境体检超过 90 秒，已停止')), 90_000)
        try {
            directory = await fs.mkdtemp(path.join(parent, 'iter-health-'))
            const context: ProbeContext = { directory, tools, signal, compiled: false }
            for (const { id } of this.report.checks) {
                if (signal.aborted) break
                if (id === 'run' && !context.compiled) {
                    this.check(id, { status: 'skipped', summary: '编译未通过，暂时无法检查运行。' })
                    continue
                }
                this.check(id, { status: 'running' })
                const start = performance.now()
                try {
                    const result = await this.probes[id](context)
                    signal.throwIfAborted()
                    this.check(id, {
                        ...result,
                        status: result.warning ? 'warning' : 'passed',
                        durationMs: Math.round(performance.now() - start)
                    })
                } catch (error) {
                    this.check(id, {
                        status: signal.aborted ? 'cancelled' : 'failed',
                        summary: signal.aborted ? '本项检查已停止。' : '本项检查未通过。',
                        detail: signal.aborted
                            ? undefined
                            : String(error instanceof Error ? error.message : error).slice(0, 8192),
                        durationMs: Math.round(performance.now() - start)
                    })
                }
            }
        } catch (error) {
            this.publish({ error: `无法准备体检样例：${error instanceof Error ? error.message : String(error)}` })
        } finally {
            clearTimeout(deadline)
            if (directory) {
                // Only remove the exact mkdtemp child created by this service.
                if (
                    path.dirname(path.resolve(directory)) !== parent ||
                    !path.basename(directory).startsWith('iter-health-')
                )
                    throw new Error('环境体检清理路径无效')
                try {
                    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
                } catch (error) {
                    this.publish({
                        error: `检查已结束，临时样例清理失败：${error instanceof Error ? error.message : String(error)}`
                    })
                }
            }
            this.publish({
                status: signal.aborted ? 'cancelled' : 'complete',
                finishedAt: new Date().toISOString(),
                error:
                    signal.reason instanceof Error && signal.reason.message.includes('90 秒')
                        ? signal.reason.message
                        : this.report.error,
                checks: this.report.checks.map((check) =>
                    check.status === 'pending'
                        ? {
                              ...check,
                              status: signal.aborted ? 'cancelled' : 'skipped',
                              summary: signal.aborted ? '已取消，未执行。' : '未执行。'
                          }
                        : check
                )
            })
        }
        return this.state()
    }
}
