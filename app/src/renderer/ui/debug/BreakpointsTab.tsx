import { useEffect, useRef } from 'react'
import { clearAllBreakpoints, removeBreakpoint, updateBreakpoint } from '../../actions/debug'
import { openFile } from '../../actions/files'
import { editorRef } from '../../editor/instance'
import { store, useApp } from '../../state/app'
import { Icon } from '../Icon'
import { Empty } from './common'

const base = (p: string): string => p.split(/[\\/]/).pop() ?? p

/** All breakpoints of all files: enable, condition, hit count, jump, remove (Red Panda's breakpoint list). */
export function BreakpointsTab() {
    const all = useApp((s) => s.breakpoints)
    const info = useApp((s) => s.debug.bpInfo)
    const editing = useApp((s) => s.debug.editBreakpoint)
    const rows = Object.entries(all).flatMap(([path, bps]) => bps.map((b) => ({ path, b })))
    if (!rows.length) return <Empty text="—" />

    const jump = async (path: string, line: number): Promise<void> => {
        await openFile(path)
        editorRef.editor?.revealLineInCenter(line)
        editorRef.editor?.setPosition({ lineNumber: line, column: 1 })
        editorRef.editor?.focus()
    }

    return (
        <div className="nv-bps">
            {rows.map(({ path, b }) => {
                const key = `${path}#${b.line}`
                const live = info.find((i) => i.file === path && i.line === b.line)
                return (
                    <div key={key} className={`nv-bprow ${editing === key ? 'is-editing' : ''}`}>
                        <div className="nv-bprow-main">
                            <input
                                type="checkbox"
                                checked={b.enabled}
                                onChange={(e) => updateBreakpoint(path, b.line, { enabled: e.target.checked })}
                                title="启用"
                            />
                            <button className="nv-bprow-loc" onClick={() => void jump(path, b.line)}>
                                {base(path)}:{b.line}
                            </button>
                            {live && (
                                <span className={`nv-faint ${live.verified ? '' : 'v-text-wa'}`} title={live.error}>
                                    {live.verified ? `命中 ${live.hits}` : '未生效'}
                                </span>
                            )}
                            <span className="nv-flex" />
                            <button className="nv-icon-btn" onClick={() => removeBreakpoint(path, b.line)} title="删除">
                                <Icon name="x" size={11} />
                            </button>
                        </div>
                        <div className="nv-bprow-props">
                            <DraftInput
                                className={live?.error ? 'is-invalid' : ''}
                                placeholder="条件"
                                value={b.condition ?? ''}
                                autoFocus={editing === key}
                                onCommit={(v) => updateBreakpoint(path, b.line, { condition: v.trim() || undefined })}
                            />
                            <DraftInput
                                className="is-narrow"
                                placeholder="第 N 次"
                                value={b.hitCondition ? String(b.hitCondition) : ''}
                                onCommit={(v) =>
                                    updateBreakpoint(path, b.line, {
                                        hitCondition: Number.parseInt(v, 10) > 1 ? Number.parseInt(v, 10) : undefined
                                    })
                                }
                            />
                        </div>
                        {live?.error && <div className="nv-bprow-error">{live.error}</div>}
                    </div>
                )
            })}
            <button className="nv-mini nv-watch-clear" onClick={clearAllBreakpoints}>
                清除全部断点
            </button>
        </div>
    )
}

/** Text input that only reports on Enter / blur, so typing a condition doesn't resend breakpoints per key. */
function DraftInput(props: {
    value: string
    placeholder: string
    className?: string
    autoFocus?: boolean
    onCommit: (v: string) => void
}) {
    const ref = useRef<HTMLInputElement>(null)
    useEffect(() => {
        if (ref.current && document.activeElement !== ref.current) ref.current.value = props.value
    }, [props.value])
    useEffect(() => {
        if (props.autoFocus) {
            ref.current?.focus()
            store.set((s) => ({ debug: { ...s.debug, editBreakpoint: null } }))
        }
    }, [props.autoFocus])
    const commit = (): void => {
        if (ref.current && ref.current.value !== props.value) props.onCommit(ref.current.value)
    }
    return (
        <input
            ref={ref}
            className={`nv-mono-input ${props.className ?? ''}`}
            defaultValue={props.value}
            placeholder={props.placeholder}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && commit()}
        />
    )
}
