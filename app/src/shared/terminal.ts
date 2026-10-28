import type { CompileResult } from './judge'

/** Native helper emits 16 KiB chunks; allow framing headroom with a fixed cap. */
export const TERMINAL_MAX_OUTPUT_FRAME_BYTES = 64 * 1024

export interface TerminalRunRequest {
    /** Renderer allocates an id before dispatch so compilation can be cancelled. */
    operationId?: string
    sourcePath: string
    /** Saved editor snapshot, compiled using the current problem/toolchain settings. */
    source: string
}

export interface TerminalRunResult {
    runId: string
    compile: CompileResult
    launched: boolean
    cancelled?: boolean
    error?: string
}
