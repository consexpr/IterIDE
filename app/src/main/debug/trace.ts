import type { BreakpointInfo, DebugResourceLimit, StackFrame, Variable } from '../../shared/debug'

export interface ExactScalar {
    kind: 'int' | 'float'
    value: string
    bits: number
    signed: boolean
}
export interface ValueNode extends Variable {
    indexable?: boolean
    scalar?: ExactScalar
    children?: ValueNode[]
    selector?: { expression: string; path: number[] }
}
export interface TraceFrame extends StackFrame {
    locals: ValueNode[]
}
export interface Snapshot {
    /** Native movement which reached a live snapshot, used by an isolated exact seeker. */
    movement?: 'step' | 'next' | 'finish' | 'continue'
    breakpoints?: BreakpointInfo[]
    outputChanges?: Partial<Record<'stdout' | 'stderr' | 'file', { reset: boolean; data: string }>>
    returnSite?: boolean
    userEntry?: boolean
    breakpointError?: { id: number; error: string }
    breakpointHits?: Record<string, { hits: number; condition?: string; file: string; line: number }>
    index: number
    file?: string
    line?: number
    frames: TraceFrame[]
    globals: ValueNode[]
    reason: 'entry' | 'step' | 'signal' | 'pause' | 'exited'
    signal?: string
    exitCode?: number | null
    stdoutOffset: number
    stderrOffset: number
    fileOutputOffset: number
    signature: string
    fingerprint: string
}
export interface RecordResult {
    snapshots: Snapshot[]
    ended: boolean
    limited?: 'steps' | 'time' | 'python-unavailable' | DebugResourceLimit
    elapsedMs: number
    timings?: Record<string, number>
}
export const publicVariable = (node: ValueNode): Variable => ({
    name: node.name,
    value: node.value,
    type: node.type,
    hasChildren: node.hasChildren,
    ref: node.ref,
    truncated: node.truncated || undefined,
    unavailable: node.unavailable || undefined,
    scope: node.scope
})
export const sameFile = (a: string | undefined, b: string | undefined): boolean => {
    const clean = (value?: string): string => {
        const text = (value ?? '').replace(/\\/g, '/')
        return process.platform === 'win32' ? text.toLowerCase() : text
    }
    return !!a && !!b && clean(a) === clean(b)
}
