import { selectFrame } from '../../actions/debug'
import { useApp } from '../../state/app'
import { Empty } from './common'

/** Call stack; clicking a frame switches locals / watches / CPU to it and shows its line. */
export function StackTab() {
    const stack = useApp((s) => s.debug.stack)
    const frame = useApp((s) => s.debug.frame)
    const paused = useApp((s) => s.debug.state.status === 'paused')
    if (!stack.length) return <Empty text={paused ? '—' : '暂停后显示'} />
    return (
        <div>
            {stack.map((f) => (
                <button
                    key={f.level}
                    className={`nv-frame ${f.level === frame ? 'is-on' : ''}`}
                    onClick={() => void selectFrame(f.level)}
                >
                    <span className="nv-frame-level">#{f.level}</span>
                    <span className="nv-frame-fn">{f.func}</span>
                    <span className="nv-faint">{f.line ? `${f.file?.split(/[\\/]/).pop() ?? ''}:${f.line}` : ''}</span>
                </button>
            ))}
        </div>
    )
}
