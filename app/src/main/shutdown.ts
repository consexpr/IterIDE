import { randomUUID } from 'node:crypto'

export interface CloseRequest {
    requestId: string
}
interface ShutdownActions {
    request(request: CloseRequest): void
    dispose(): Promise<void>
    close(restart?: boolean): void
    notify(message: string): void
}
/** Window destruction must wait for renderer persistence and owned process cleanup. */
export class ShutdownCoordinator {
    private phase: 'open' | 'waiting' | 'disposing' | 'ready' = 'open'
    private requestId?: string
    private timer?: ReturnType<typeof setTimeout>
    private recovery?: Promise<void>
    constructor(
        private readonly actions: ShutdownActions,
        private readonly timeoutMs = 30_000,
        private readonly disposeTimeoutMs = 8_000
    ) {}
    get canClose(): boolean {
        return this.phase === 'ready'
    }
    request(): void {
        if (this.phase !== 'open') return
        this.phase = 'waiting'
        this.requestId = randomUUID()
        this.timer = setTimeout(() => this.cancel('等待保存确认超时，窗口已保留。'), this.timeoutMs)
        try {
            this.actions.request({ requestId: this.requestId })
        } catch {
            this.cancel('无法确认保存状态，窗口已保留。')
        }
    }
    private cancel(message?: string): void {
        clearTimeout(this.timer)
        this.timer = undefined
        this.phase = 'open'
        this.requestId = undefined
        if (message) this.actions.notify(message)
    }
    async resolve(requestId: string, decision: 'ready' | 'cancel'): Promise<void> {
        if (this.phase !== 'waiting' || requestId !== this.requestId) {
            if (decision === 'ready') throw new Error('关闭请求已取消或过期，窗口已保留')
            return
        }
        if (decision === 'cancel') {
            this.cancel()
            return
        }
        clearTimeout(this.timer)
        this.phase = 'disposing'
        let timeout: ReturnType<typeof setTimeout> | undefined
        try {
            await Promise.race([
                this.actions.dispose(),
                new Promise<never>((_, reject) => {
                    timeout = setTimeout(() => reject(new Error('后台任务清理超时')), this.disposeTimeoutMs)
                })
            ])
            if (this.recovery) return
            this.phase = 'ready'
            // Reply to the IPC before destroying its sender.
            setImmediate(() => this.actions.close())
        } catch (error) {
            if (this.recovery) return
            this.cancel(`退出未完成：${error instanceof Error ? error.message : String(error)}。窗口已保留。`)
            throw error
        } finally {
            clearTimeout(timeout)
        }
    }

    /** Explicit recovery after renderer failure cannot wait for an acknowledgment from that renderer. */
    recover(action: 'restart' | 'exit'): Promise<void> {
        if (this.recovery) return this.recovery
        if (this.phase === 'ready') return Promise.resolve()
        clearTimeout(this.timer)
        this.requestId = undefined
        this.phase = 'disposing'
        this.recovery = (async () => {
            let timeout: ReturnType<typeof setTimeout> | undefined
            try {
                await Promise.race([
                    this.actions.dispose(),
                    new Promise<never>((_, reject) => {
                        timeout = setTimeout(() => reject(new Error('异常恢复时后台清理超时')), this.disposeTimeoutMs)
                    })
                ])
            } catch (error) {
                // The user already chose to leave the failed process. Never strand them behind dead IPC.
                console.error('[iter] recovery cleanup failed', error)
            } finally {
                clearTimeout(timeout)
            }
            this.phase = 'ready'
            setImmediate(() => this.actions.close(action === 'restart'))
        })()
        return this.recovery
    }
}
