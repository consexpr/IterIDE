import type { DebugState, DebugTraceInfo } from '../../../shared/debug'

export function recordedState(state: DebugState) {
    if (
        !['paused', 'exited', 'running'].includes(state.status) ||
        !('totalSteps' in state) ||
        !Number.isSafeInteger(state.totalSteps) ||
        state.totalSteps < 2
    )
        return null
    return state
}

export function recordingNotice(state: DebugState): string | null {
    if (!('totalSteps' in state)) return null
    const info: DebugTraceInfo = state
    if (info.recordingError)
        return `自动录制中断：${info.recordingError}；已保留 ${info.totalSteps} 步，可继续浏览已有记录。`
    if (info.resourceLimit) {
        const label = { output: '输出', trace: '记录文件', nodes: '变量节点' }[info.resourceLimit]
        return `调试${label}达到上限，程序已停止；已保留 ${info.totalSteps} 步，可继续回放。`
    }
    if (!info.recordingLimit) return null
    const why =
        info.recordingLimit === 'time'
            ? `自动录制达到 ${(info.recordingLimits?.maxDurationMs ?? 30000) / 1000} 秒上限`
            : info.recordingLimit === 'steps'
              ? `自动录制达到 ${info.recordingLimits?.maxSteps ?? info.totalSteps} 步上限`
              : '当前 GDB 不支持 Python 自动录制'
    return `${why}；已有 ${info.totalSteps} 步仍可回放，${info.recordingEnded ? '程序已结束。' : '记录末尾使用实时调试。'}`
}
