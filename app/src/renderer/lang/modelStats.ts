// What the completion model has done in this session, for the status bar.

export interface ModelStats {
    /** Inferences that returned an order. */
    calls: number
    /** Completions that reused the last order while the same word was extended. */
    reused: number
    /** Inferences that failed, timed out or returned something unusable (not user cancellations). */
    failed: number
    lastMs: number | null
    totalMs: number
}

const EMPTY: ModelStats = { calls: 0, reused: 0, failed: 0, lastMs: null, totalMs: 0 }
let stats = EMPTY
const listeners = new Set<() => void>()

const publish = (next: ModelStats): void => {
    stats = next
    for (const listener of listeners) listener()
}

export const getModelStats = (): ModelStats => stats
export function subscribeModelStats(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

export const recordModelCall = (ms: number): void =>
    publish({ ...stats, calls: stats.calls + 1, lastMs: ms, totalMs: stats.totalMs + ms })
export const recordModelReuse = (): void => publish({ ...stats, reused: stats.reused + 1 })
export const recordModelFailure = (): void => publish({ ...stats, failed: stats.failed + 1 })
export const resetModelStats = (): void => publish(EMPTY)
