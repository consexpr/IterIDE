import { Worker } from 'node:worker_threads'
import {
    MODEL_REQUEST_TIMEOUT_MS,
    validModelRequest,
    validModelResult,
    type ModelRequest,
    type ModelResult
} from '../../shared/model'

type RankWorker = Pick<Worker, 'on' | 'once' | 'postMessage' | 'terminate'>
interface Options {
    workerFile: string
    assets: string
    library: string
    scratch: string
    enabled(): boolean
    unavailable?(): void
    createWorker?(file: string, data: Record<string, string>): RankWorker
}
interface Job {
    request: ModelRequest
    resolve(result: ModelResult | null): void
    timer: ReturnType<typeof setTimeout>
    done: boolean
}

/** One inference plus the newest waiting request; never block Electron's main thread. */
export class ModelService {
    private worker?: RankWorker
    private helper?: number
    private generation = 0
    private ready = false
    private disposed = false
    private active?: Job
    private queued?: Job
    private warmTimer?: ReturnType<typeof setTimeout>
    private watchdog?: ReturnType<typeof setTimeout>
    private retryAfter = 0
    private notified = false
    private readonly stopping = new Set<Promise<void>>()

    constructor(private readonly options: Options) {}

    prepare(): void {
        if (this.disposed) return
        if (!this.options.enabled()) {
            this.notified = false
            void this.stop()
            return
        }
        if (this.worker || Date.now() < this.retryAfter) return
        const generation = ++this.generation
        const data = { assets: this.options.assets, library: this.options.library, scratch: this.options.scratch }
        try {
            const worker =
                this.options.createWorker?.(this.options.workerFile, data) ??
                new Worker(this.options.workerFile, {
                    workerData: data,
                    execArgv: [],
                    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 }
                })
            this.worker = worker
            const failed = (): void => {
                if (generation === this.generation) this.failed()
            }
            worker.on('error', failed)
            worker.on('exit', failed)
            worker.on('message', (message) => {
                if (generation !== this.generation) return
                if (message?.type === 'helper' && Number.isInteger(message.pid) && message.pid > 0)
                    this.helper = message.pid
                else if (message?.type === 'ready') {
                    clearTimeout(this.warmTimer)
                    this.ready = true
                    this.pump()
                } else if (message?.type === 'unavailable') failed()
                else if (message?.type === 'result' && this.active && this.active.request.id === message.id) {
                    const job = this.active
                    this.active = undefined
                    clearTimeout(this.watchdog)
                    this.finish(
                        job,
                        validModelResult(message.result, job.request.candidates.length) ? message.result : null
                    )
                    this.pump()
                }
            })
            this.warmTimer = setTimeout(failed, 6000)
        } catch {
            this.failed()
        }
    }

    rank(value: unknown): Promise<ModelResult | null> {
        if (this.disposed || !validModelRequest(value)) return Promise.resolve(null)
        this.prepare()
        if (
            !this.ready ||
            !this.options.enabled() ||
            value.id === this.active?.request.id ||
            value.id === this.queued?.request.id
        )
            return Promise.resolve(null)
        if (this.queued) this.finish(this.queued, null)
        return new Promise((resolve) => {
            const job: Job = {
                request: value,
                resolve,
                done: false,
                timer: setTimeout(() => this.finish(job, null), MODEL_REQUEST_TIMEOUT_MS)
            }
            this.queued = job
            this.pump()
        })
    }

    cancel(id: string): void {
        if (this.active?.request.id === id) this.finish(this.active, null)
        if (this.queued?.request.id === id) this.finish(this.queued, null)
    }

    private finish(job: Job, result: ModelResult | null): void {
        if (job.done) return
        job.done = true
        clearTimeout(job.timer)
        if (this.queued === job) this.queued = undefined
        job.resolve(result)
    }

    private pump(): void {
        if (!this.ready || this.active || !this.queued || !this.worker) return
        const job = this.queued
        this.queued = undefined
        this.active = job
        try {
            this.worker.postMessage({ type: 'rank', request: job.request })
            this.watchdog = setTimeout(() => this.failed(), 1000)
        } catch {
            this.failed()
        }
    }

    private failed(): void {
        this.retryAfter = Date.now() + 3000
        if (!this.notified && this.options.enabled()) {
            this.notified = true
            this.options.unavailable?.()
        }
        void this.stop(true)
    }

    private stop(force = false): Promise<void> {
        ++this.generation
        this.ready = false
        clearTimeout(this.warmTimer)
        clearTimeout(this.watchdog)
        if (this.active) this.finish(this.active, null)
        if (this.queued) this.finish(this.queued, null)
        this.active = this.queued = undefined
        const worker = this.worker,
            helper = this.helper
        this.worker = undefined
        this.helper = undefined
        if (!worker) return Promise.resolve()
        const terminate = async (): Promise<void> => {
            if (helper) {
                try {
                    process.kill(helper)
                } catch {
                    /* Only this worker's owned helper is targeted. */
                }
            }
            await worker.terminate().catch(() => {})
        }
        const stopped = (async () => {
            if (force) {
                await terminate()
                return
            }
            // Let WASM release its session before Electron tears down V8. Bound faulty shutdowns.
            const exited = await new Promise<boolean>((resolve) => {
                const timer = setTimeout(() => resolve(false), 1000)
                worker.once('exit', () => {
                    clearTimeout(timer)
                    resolve(true)
                })
                try {
                    worker.postMessage({ type: 'dispose' })
                } catch {
                    clearTimeout(timer)
                    resolve(false)
                }
            })
            if (!exited) await terminate()
        })()
        this.stopping.add(stopped)
        void stopped.finally(() => this.stopping.delete(stopped))
        return stopped
    }

    async dispose(): Promise<void> {
        this.disposed = true
        void this.stop()
        await Promise.all(this.stopping)
    }
}
