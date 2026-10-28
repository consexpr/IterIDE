/** Repeated keyboard steps are dropped, never queued; a different step replaces the pending intent. */
export class DebugStepGate {
    private flight: { command: string } | null = null

    get busy(): boolean {
        return this.flight !== null
    }
    isBusy(command: string): boolean {
        return this.flight?.command === command
    }

    /** Navigation/stop starts a new context even if an earlier IPC promise is pending. */
    invalidate(): void {
        this.flight = null
    }

    run(command: string, work: () => Promise<void>, onError: (error: unknown) => void): boolean {
        if (this.isBusy(command)) return false
        const flight = (this.flight = { command })
        void (async () => {
            try {
                await work()
            } catch (error) {
                if (this.flight === flight) onError(error)
            } finally {
                if (this.flight === flight) this.flight = null
            }
        })()
        return true
    }
}
