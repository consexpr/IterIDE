// Right-click menu of the line-number gutter (Red Panda's gutter menu): breakpoint actions + go to line.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { clearAllBreakpoints, editBreakpointAtLine, toggleBreakpoint } from '../actions/debug'
import { keyLabel } from '../commands/registry'
import { editorRef } from '../editor/instance'

export interface GutterMenuAt {
    x: number
    y: number
    line: number
}

export function GutterMenu({ at, onClose }: { at: GutterMenuAt; onClose: () => void }) {
    const ref = useRef<HTMLDivElement>(null)
    const [pos, setPos] = useState({ left: at.x, top: at.y })

    // keep the menu inside the window
    useLayoutEffect(() => {
        const r = ref.current?.getBoundingClientRect()
        if (!r) return
        setPos({
            left: Math.min(at.x, window.innerWidth - r.width - 4),
            top: Math.min(at.y, window.innerHeight - r.height - 4)
        })
    }, [at])

    useEffect(() => {
        const away = (e: MouseEvent): void => {
            if (!ref.current?.contains(e.target as Node)) onClose()
        }
        const key = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') onClose()
        }
        window.addEventListener('mousedown', away, true)
        window.addEventListener('keydown', key, true)
        window.addEventListener('blur', onClose)
        return () => {
            window.removeEventListener('mousedown', away, true)
            window.removeEventListener('keydown', key, true)
            window.removeEventListener('blur', onClose)
        }
    }, [onClose])

    const item = (label: string, run: () => void, command?: string) => (
        <button
            className="nv-gmenu-item"
            onClick={() => {
                onClose()
                run()
            }}
        >
            <span>{label}</span>
            {command && <span className="nv-gmenu-key">{keyLabel(command)}</span>}
        </button>
    )

    return (
        <div ref={ref} className="nv-gmenu" style={pos} onContextMenu={(e) => e.preventDefault()}>
            {item('切换断点', () => toggleBreakpoint(at.line), 'debug.breakpoint')}
            {item('设置断点条件…', () => editBreakpointAtLine(at.line))}
            {item('删除所有断点', clearAllBreakpoints)}
            <div className="nv-gmenu-sep" />
            {item('跳转到行…', () => {
                editorRef.editor?.focus()
                editorRef.editor?.trigger('gutter', 'editor.action.gotoLine', {})
            })}
        </div>
    )
}
