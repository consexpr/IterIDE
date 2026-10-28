import type { Breakpoint, DebugCommand, DebugRecordingOptions, DebugStartRequest } from '../../shared/debug'

const invalid = (field: string): never => {
    throw new Error(`无效的调试参数：${field}`)
}
function object(value: unknown, field: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(field)
    return value as Record<string, unknown>
}
export function debugText(value: unknown, field: string, maximum = 16_384, empty = false): string {
    if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > maximum || value.includes('\0'))
        return invalid(field)
    return value
}
export function debugIndex(value: unknown, field: string, minimum = 0): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) return invalid(field)
    return value
}
export function debugCommand(value: unknown): DebugCommand {
    if (
        typeof value !== 'string' ||
        !['continue', 'stepOver', 'next', 'stepIn', 'stepOut', 'stepBack', 'pause', 'stop', 'restart'].includes(value)
    )
        return invalid('command')
    return value as DebugCommand
}
export function debugBreakpoints(value: unknown): Breakpoint[] {
    if (!Array.isArray(value) || value.length > 4096) return invalid('breakpoints')
    return Array.from(value, (entry, index) => {
        const bp = object(entry, `breakpoints[${index}]`)
        if (typeof bp.enabled !== 'boolean') return invalid('breakpoint.enabled')
        if (bp.hitCondition !== undefined && (typeof bp.hitCondition !== 'number' || !Number.isFinite(bp.hitCondition)))
            return invalid('breakpoint.hitCondition')
        return {
            line: debugIndex(bp.line, 'breakpoint.line', 1),
            enabled: bp.enabled,
            ...(bp.condition === undefined
                ? {}
                : { condition: debugText(bp.condition, 'breakpoint.condition', 16_384, true) }),
            ...(bp.hitCondition === undefined ? {} : { hitCondition: bp.hitCondition as number })
        }
    })
}
export function debugRequest(value: unknown): DebugStartRequest {
    const req = object(value, 'start'),
        breakpoints = debugBreakpoints(req.breakpoints)
    let recording: DebugRecordingOptions | undefined
    if (req.recording !== undefined) {
        const options = object(req.recording, 'recording')
        recording = {}
        for (const key of [
            'maxSteps',
            'maxDurationMs',
            'maxChildren',
            'maxDepth',
            'maxNodes',
            'maxTraceBytes',
            'maxTotalNodes'
        ] as const) {
            if (options[key] === undefined) continue
            if (typeof options[key] !== 'number' || !Number.isFinite(options[key])) return invalid(`recording.${key}`)
            recording[key] = options[key]
        }
    }
    if (req.stopAtEntry !== undefined && typeof req.stopAtEntry !== 'boolean') return invalid('stopAtEntry')
    return {
        sourcePath: debugText(req.sourcePath, 'sourcePath', 32_768),
        source: debugText(req.source, 'source', 16 * 1024 * 1024, true),
        breakpoints,
        ...(req.input === undefined ? {} : { input: debugText(req.input, 'input', 64 * 1024 * 1024, true) }),
        ...(req.testId === undefined ? {} : { testId: debugText(req.testId, 'testId', 1024) }),
        ...(req.stopAtEntry === undefined ? {} : { stopAtEntry: req.stopAtEntry }),
        ...(recording ? { recording } : {})
    }
}
