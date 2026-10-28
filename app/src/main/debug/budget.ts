import type { DebugResourceLimit } from '../../shared/debug'
export const MAX_TRACE_BYTES = 128 * 1024 * 1024
export const MAX_TRACE_NODES = 1_000_000
export class DebugLimitError extends Error {
    constructor(readonly limit: DebugResourceLimit) {
        super(`Debug resource limit: ${limit}`)
    }
}
export const resourceMessage = (limit: DebugResourceLimit): string =>
    ({
        output: '调试输出达到上限，执行已停止，已有记录仍可浏览',
        trace: '调试记录达到 128 MiB 上限，执行已停止，已有记录仍可浏览',
        nodes: '调试累计节点达到上限，执行已停止，已有记录仍可浏览'
    })[limit]
/** Both automatic recording and manually advanced live snapshots charge here. */
export class TraceBudget {
    private bytes = 0
    private nodes = 0
    constructor(
        private readonly maxBytes = MAX_TRACE_BYTES,
        private readonly maxNodes = MAX_TRACE_NODES
    ) {}
    accept(bytes: number, nodes: number): void {
        if (this.bytes + bytes > this.maxBytes) throw new DebugLimitError('trace')
        if (this.nodes + nodes > this.maxNodes) throw new DebugLimitError('nodes')
        this.bytes += bytes
        this.nodes += nodes
    }
}
