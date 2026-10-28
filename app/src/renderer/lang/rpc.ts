import type { IterApi } from '../../shared/api'

export interface RequestHandle<T> {
    promise: Promise<T | undefined>
    cancel(): void
}
interface Pending {
    finish(value: unknown): void
    timer: ReturnType<typeof setTimeout>
}

/** Failed/cancelled requests resolve undefined: provider cancellation is normal UI traffic. */
export class LspClient {
    private nextId = 0
    private pending = new Map<number, Pending>()
    private probes = new Map<number, () => void>()
    private readonly unsubscribe: () => void
    constructor(
        private readonly transport: IterApi['lsp'],
        private readonly notification: (method: string, params: any) => void
    ) {
        this.unsubscribe = transport.onMessage((value) => {
            if (!value || typeof value !== 'object') return
            const message = value as {
                id?: number | string
                method?: string
                params?: any
                result?: unknown
                error?: unknown
            }
            if (message.method) {
                if (message.id !== undefined) {
                    // clangd requests configuration/workspace folders; never leave it waiting.
                    const result =
                        message.method === 'workspace/configuration'
                            ? (message.params?.items ?? []).map(() => null)
                            : null
                    this.send({ jsonrpc: '2.0', id: message.id, result })
                } else this.notification(message.method, message.params)
            } else if (typeof message.id === 'number') {
                const probe = this.probes.get(message.id)
                if (probe) probe()
                else this.finish(message.id, message.error ? undefined : message.result)
            }
        })
    }

    notify(method: string, params: unknown): void {
        this.send({ jsonrpc: '2.0', method, params })
    }

    request<T>(method: string, params: unknown, timeout = 10000): RequestHandle<T> {
        const id = ++this.nextId
        const promise = new Promise<T | undefined>((resolve) => {
            this.pending.set(id, {
                finish: (value) => resolve(value as T | undefined),
                timer: setTimeout(() => cancel(), timeout)
            })
        })
        const cancel = (): void => {
            if (!this.pending.has(id)) return
            this.notify('$/cancelRequest', { id })
            this.finish(id, undefined)
        }
        if (!this.send({ jsonrpc: '2.0', id, method, params })) this.finish(id, undefined)
        return { promise, cancel }
    }

    /** Whether the server answers at all (an error reply counts), within `timeout` ms. */
    probe(timeout = 5000): Promise<boolean> {
        const id = ++this.nextId
        return new Promise((resolve) => {
            const done = (alive: boolean): void => {
                clearTimeout(timer)
                this.probes.delete(id)
                resolve(alive)
            }
            const timer = setTimeout(() => {
                this.notify('$/cancelRequest', { id })
                done(false)
            }, timeout)
            this.probes.set(id, () => done(true))
            if (!this.send({ jsonrpc: '2.0', id, method: 'iter/ping', params: {} })) done(false)
        })
    }

    reset(): void {
        for (const id of [...this.pending.keys()]) this.finish(id, undefined)
    }
    dispose(): void {
        this.reset()
        this.unsubscribe()
    }

    private finish(id: number, value: unknown): void {
        const pending = this.pending.get(id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(id)
        pending.finish(value)
    }
    private send(message: unknown): boolean {
        try {
            this.transport.send(message)
            return true
        } catch {
            return false
        }
    }
}
