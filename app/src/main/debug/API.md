# Replay debugger API

Exact declarations for renderer integration. The source contracts remain authoritative.

Removed: setVariable, addWatchpoint, removeWatchpoint, watchpoints, disassemble, registers, readMemory, consoleCommand; Watchpoint, Instruction, Register, MemoryBlock; instruction commands; watchpoint reason/watch state; console events; Variable.editable and StackFrame.addr. The legacy `next` command remains an alias of `stepOver`. Added: seek, recording options/progress, trace metadata, output replacement, truncation/unavailability/scope. Breakpoint IDs are stable session-local virtual IDs rather than native GDB IDs.

## IterApi.debug

```ts
  debug: {
    start(req: DebugStartRequest): Promise<void>
    command(cmd: DebugCommand): Promise<void>
    setBreakpoints(sourcePath: string, bps: Breakpoint[]): Promise<void>
    evaluate(expr: string): Promise<{ value: string; type?: string } | null>
    /** Automatic hover: bounded read-only syntax, with inferior calls disabled. */
    inspect(expr: string): Promise<{ value: string; type?: string } | null>
    locals(): Promise<Variable[]>
    children(ref: string): Promise<Variable[]>
    stack(): Promise<StackFrame[]>
    runToCursor(sourcePath: string, line: number): Promise<void>
    selectFrame(level: number): Promise<void>
    breakpoints(): Promise<BreakpointInfo[]>
    seek(index: number): Promise<void>
    onEvent(cb: (e: DebugEvent) => void): () => void
  }
```

## Shared debug types

```ts
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
}
export interface DebugTraceInfo {
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
  | ({ status: 'paused'; reason: 'entry' | 'step' | 'breakpoint' | 'signal' | 'pause' | 'cursor' | 'seek';
      file?: string; line?: number; signal?: string; frame: number; stepIndex: number;
      canStepBack: boolean; message?: string } & DebugTraceInfo)
  | ({ status: 'exited'; exitCode: number | null; stdout: string; stderr: string;
      stepIndex: number; canStepBack: boolean } & DebugTraceInfo)
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
export type DebugCommand = 'continue' | 'stepOver' | 'next' | 'stepIn' | 'stepOut' | 'stepBack' | 'pause' | 'stop' | 'restart'
export type DebugEvent =
  | { type: 'state'; state: DebugState }
  | { type: 'stdout'; text: string }
  | { type: 'stderr'; text: string }
  /** Replace both panes, including when navigating backwards. Offsets are UTF-8 bytes. */
  | { type: 'output'; stdout: string; stderr: string; stdoutOffset: number; stderrOffset: number }
  | { type: 'breakpoints'; breakpoints: BreakpointInfo[] }
  | { type: 'recording'; steps: number; done: boolean; elapsedMs?: number; limited?: 'steps' | 'time' | 'python-unavailable' }
```
