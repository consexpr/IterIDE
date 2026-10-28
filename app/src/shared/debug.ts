export interface Breakpoint {
    line: number
    condition?: string
    enabled: boolean
    /** Stop on the Nth condition-matching visit and subsequent matching visits. */
    hitCondition?: number
}
export interface BreakpointInfo extends Breakpoint {
    id: number
    file: string
    hits: number
    verified: boolean
    error?: string
}
export interface StackFrame {
    level: number
    func: string
    file?: string
    line?: number
}
export interface Variable {
    name: string
    value: string
    type?: string
    /** Opaque, snapshot-specific reference. */
    ref?: string
    hasChildren: boolean
    /** Some children/value text were omitted; evaluate/children can query GDB. */
    truncated?: boolean
    /** GDB could not read this value; never a substituted/guessed value. */
    unavailable?: boolean
    scope?: 'local' | 'global'
}
export interface DebugRecordingOptions {
    maxSteps?: number // default 20000
    maxDurationMs?: number // default 30000, from the first requested stop; includes time spent inside a step
    maxChildren?: number // default 200 per aggregate
    maxDepth?: number // default 3 aggregate levels
    maxNodes?: number // default 2000 nodes per snapshot
    /** Per-session lower budgets; cannot exceed the application caps. */
    maxTraceBytes?: number // default/max 128 MiB
    maxTotalNodes?: number // default/max 1000000
}
export interface DebugTraceInfo {
    /** Why automatic recording stopped while native execution is still available. */
    recordingLimit?: 'steps' | 'time' | 'python-unavailable'
    /** Effective per-session limits, after validation/clamping. */
    recordingLimits?: { maxSteps: number; maxDurationMs: number }
    /** Recording/native failure; the accepted prefix remains browseable. */
    recordingError?: string
    /** Execution stopped at a resource budget; captured history remains readable. */
    resourceLimit?: DebugResourceLimit
    mode: 'replay' | 'live'
    /** Number of captured snapshots, including the terminal snapshot when present. */
    totalSteps: number
    recordingComplete: boolean
    recordingEnded: boolean
    recordingMs: number
    final?: { exitCode: number | null; signal?: string }
}
export type DebugState =
    | { status: 'idle' }
    | { status: 'starting' }
    | { status: 'recording'; mode: 'replay'; steps: number }
    | ({ status: 'running'; stepIndex: number } & DebugTraceInfo)
    | ({
          status: 'paused'
          reason: 'entry' | 'step' | 'breakpoint' | 'signal' | 'pause' | 'cursor' | 'seek'
          file?: string
          line?: number
          signal?: string
          frame: number
          stepIndex: number
          canStepBack: boolean
          message?: string
      } & DebugTraceInfo)
    | ({
          status: 'exited'
          exitCode: number | null
          stdout: string
          stderr: string
          stepIndex: number
          canStepBack: boolean
      } & DebugTraceInfo)
    | { status: 'error'; message: string }
export interface DebugStartRequest {
    sourcePath: string
    source: string
    testId?: string
    input?: string
    breakpoints: Breakpoint[]
    stopAtEntry?: boolean
    /** Per-session recording settings; no global settings mutation. */
    recording?: DebugRecordingOptions
}
/** `next` is the legacy alias for stepOver. */
export type DebugCommand =
    | 'continue'
    | 'stepOver'
    | 'next'
    | 'stepIn'
    | 'stepOut'
    | 'stepBack'
    | 'pause'
    | 'stop'
    | 'restart'
export type DebugEvent =
    | { type: 'state'; state: DebugState }
    | { type: 'stdout'; text: string }
    | { type: 'stderr'; text: string }
    /** Replace both panes, including when navigating backwards. Offsets are UTF-8 bytes. */
    | { type: 'output'; stdout: string; stderr: string; stdoutOffset: number; stderrOffset: number }
    | {
          type: 'output-delta'
          stdout?: string
          stderr?: string
          resetStdout?: boolean
          resetStderr?: boolean
          stdoutOffset: number
          stderrOffset: number
      }
    | { type: 'breakpoints'; breakpoints: BreakpointInfo[] }
    | {
          type: 'recording'
          steps: number
          done: boolean
          elapsedMs?: number
          limited?: 'steps' | 'time' | 'python-unavailable' | DebugResourceLimit
      }
export type DebugResourceLimit = 'output' | 'trace' | 'nodes'
