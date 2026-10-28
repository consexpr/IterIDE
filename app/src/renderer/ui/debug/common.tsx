import { useApp } from '../../state/app'

export const Empty = ({ text }: { text: string }) => <div className="nv-faint nv-dempty">{text}</div>

/** Re-fetch values whenever the current stop or selected stack frame changes. */
export function usePauseKey(): string {
    return useApp((s) =>
        s.debug.state.status === 'paused'
            ? `${s.debug.state.stepIndex}:${s.debug.frame}:${s.debug.state.line}`
            : s.debug.state.status
    )
}
