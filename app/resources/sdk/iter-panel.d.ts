/** Copy into a plugin project, or reference this file with a triple-slash reference. */
interface IterPanelState {
    file: { path: string; name: string } | null
    problem: unknown | null
    tests: { id: string; name: string; enabled: boolean }[]
    results: Record<string, { verdict: string; timeMs: number; memoryKb?: number }>
    debugging: boolean
    theme: { id: string; kind: 'dark' | 'light'; vars: Record<string, string> }
}

interface IterPanel {
    /** Immediately receives the latest snapshot if one has arrived. Returns an unsubscribe function. */
    onState(callback: (state: IterPanelState) => void): () => void
    invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>
    /** null when there is no active editor. */
    getSource(): Promise<string | null>
    insertText(text: string): Promise<void>
    openFile(path: string): Promise<void>
    runTests(ids?: string[]): Promise<void>
    toast(text: string, kind?: 'info' | 'success' | 'error'): Promise<void>
    setBadge(text: string | null): Promise<void>
}

declare const iter: IterPanel
interface Window {
    readonly iter: IterPanel
}

/** @deprecated Compatibility declarations for plugins authored before the rename. */
type NavenPanelState = IterPanelState
/** @deprecated Use IterPanel. */
type NavenPanel = IterPanel
/** @deprecated Use iter. */
declare const naven: IterPanel
interface Window {
    /** @deprecated Use iter. */
    readonly naven: IterPanel
}
