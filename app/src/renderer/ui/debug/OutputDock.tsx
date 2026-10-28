import { useState } from 'react'
import { useApp } from '../../state/app'
import { Icon } from '../Icon'
import { load, save } from '../../util/storage'

/** Program stdout / cerr while debugging, docked under the debug pages; collapsible. */
export function OutputDock() {
    const stdout = useApp((s) => s.debug.stdout)
    const stderr = useApp((s) => s.debug.stderr)
    const [open, setOpen] = useState(() => load('iter.debugOutputOpen', true))
    const toggle = (): void => {
        save('iter.debugOutputOpen', !open)
        setOpen(!open)
    }
    return (
        <div className={`nv-dock ${open ? 'is-open' : ''}`}>
            <button className="nv-dsec-head" onClick={toggle}>
                <span className={`nv-tree-caret ${open ? 'is-open' : ''}`}>
                    <Icon name="chevron" size={12} />
                </span>
                输出 · cerr
            </button>
            {open && (
                <div className="nv-dock-body">
                    <pre className="nv-debug-stream">{stdout || <span className="nv-faint">（无）</span>}</pre>
                    <pre className="nv-debug-stream is-err">{stderr || <span className="nv-faint">（无）</span>}</pre>
                </div>
            )}
        </div>
    )
}
