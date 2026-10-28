export type Verdict =
    | 'PENDING'
    | 'RUNNING'
    | 'AC'
    | 'WA'
    | 'PE' // presentation error (checker reported)
    | 'TLE'
    | 'MLE'
    | 'RE'
    | 'OLE' // output limit exceeded
    | 'CE'
    | 'SE' // system / checker / interactor failure
    | 'NA' // ran fine, no answer to compare against

export interface CompileResult {
    ok: boolean
    /** Path of the produced executable when ok. */
    exe?: string
    /** Raw compiler stderr+stdout. */
    output: string
    diagnostics: Diagnostic[]
    timeMs: number
    /** true when the binary was reused from cache (source+flags unchanged). */
    cached: boolean
}

export interface Diagnostic {
    file?: string
    line: number // 1-based
    column: number // 1-based
    endLine?: number
    endColumn?: number
    severity: 'error' | 'warning' | 'info' | 'hint'
    message: string
    source?: string // 'g++' | 'clangd'
}

export interface TestResult {
    testId: string
    verdict: Verdict
    timeMs: number
    memoryKb?: number
    exitCode: number | null
    signal?: string | null
    /** Program stdout (or the file-IO output file). Truncated for display. */
    output: string
    /** Program stderr — shown in the cerr pane. Truncated for display. */
    stderr: string
    /** Checker / interactor message (testlib's message, diff summary, ...). */
    checkerMessage?: string
    /** Interactive mode: interactor stderr. */
    interactorLog?: string
    truncated?: boolean
}

export interface JudgeRequest {
    /** Renderer allocates this before dispatch so early events have an owner. */
    operationId?: string
    /** Absolute path of the source file (unsaved content is passed separately). */
    sourcePath: string
    /** Current editor content; judged instead of what is on disk. */
    source: string
    /** Ids of tests to run; empty = all enabled tests. */
    testIds?: string[]
}

/** Streamed from main → renderer while a judge run progresses. */
export type JudgeEvent =
    | { type: 'compile-start'; runId: string }
    | { type: 'compile-done'; runId: string; result: CompileResult }
    | { type: 'test-start'; runId: string; testId: string }
    | { type: 'test-done'; runId: string; result: TestResult }
    | { type: 'done'; runId: string; summary: { total: number; passed: number; verdict: Verdict } }
    | { type: 'error'; runId: string; message: string }

export interface ToolchainSettings {
    compiler: string // e.g. g++
    /** Flags for judging builds. */
    flags: string // e.g. -std=c++17 -O2 -Wall
    /** Flags for debug builds. */
    debugFlags: string // e.g. -std=c++17 -g -O0
    gdb: string
    clangd: string
    clangFormat: string // e.g. clang-format
    /** Max parallel test processes. */
    parallel: number
    /** Kill the program after this many bytes of output. */
    outputLimitBytes: number
    /** Characters shown in UI per stream. */
    displayLimitChars: number
}

export type ToolName = 'compiler' | 'gdb' | 'clangd' | 'clangFormat'
export interface ResolvedTool {
    command: string
    source: 'bundled' | 'configured' | 'path'
}
export type ToolchainStatus = Record<ToolName, (ResolvedTool & { version: string }) | { error: string }>
