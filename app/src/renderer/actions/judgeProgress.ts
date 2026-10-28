import type { TestResult } from '../../shared/judge'

/** Coalesce engine bursts into one immutable result patch per run and display frame. */
export class JudgeProgressBatch {
    private readonly pending = new Map<string, Record<string, TestResult>>()
    private timer?: ReturnType<typeof setTimeout>

    constructor(private readonly commit: (runId: string, results: Record<string, TestResult>) => void) {}

    enqueue(runId: string, result: TestResult): void {
        let results = this.pending.get(runId)
        if (!results) {
            results = {}
            this.pending.set(runId, results)
        }
        results[result.testId] = result
        this.timer ??= setTimeout(() => this.flush(), 16)
    }

    flush(runId?: string): void {
        const ids = runId === undefined ? [...this.pending.keys()] : [runId]
        for (const id of ids) {
            const results = this.pending.get(id)
            if (!results) continue
            this.pending.delete(id)
            this.commit(id, results)
        }
        if (!this.pending.size) {
            clearTimeout(this.timer)
            this.timer = undefined
        }
    }
}
