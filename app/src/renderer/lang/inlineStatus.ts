const listeners = new Set<() => void>()
let pending = 0
export const getInlinePending = (): boolean => pending > 0
export function subscribeInlineStatus(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}
export function beginInlineRequest(): () => void {
    pending++
    for (const listener of listeners) listener()
    let finished = false
    return () => {
        if (finished) return
        finished = true
        pending--
        for (const listener of listeners) listener()
    }
}
