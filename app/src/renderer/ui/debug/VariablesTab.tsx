import { useEffect, useState } from 'react'
import type { Variable } from '../../../shared/debug'
import { useApp } from '../../state/app'
import { Icon } from '../Icon'
import { Empty } from './common'

export function VariablesTab() {
    const locals = useApp((s) => s.debug.locals)
    if (!locals.length) return <Empty text="—" />
    return (
        <div className="nv-vars">
            {locals.map((v) => (
                <VarRow key={v.name} v={v} depth={0} />
            ))}
        </div>
    )
}

/** Expandable variable row; children are fetched on first expand. */
export function VarRow({ v, depth }: { v: Variable; depth: number }) {
    const [open, setOpen] = useState(false)
    const [kids, setKids] = useState<Variable[] | null>(null)
    const pauseKey = useApp((s) =>
        s.debug.state.status === 'paused' ? `${s.debug.state.stepIndex}:${s.debug.frame}` : s.debug.state.status
    )
    useEffect(() => {
        let alive = true
        setKids(null)
        if (open && v.hasChildren && v.ref)
            void window.iter.debug
                .children(v.ref)
                .then((children) => alive && setKids(children))
                .catch(() => alive && setKids([]))
        return () => {
            alive = false
        }
    }, [open, v.ref, v.hasChildren, pauseKey])
    const toggle = (): void => {
        if (v.hasChildren && v.ref) setOpen((value) => !value)
    }
    return (
        <>
            <div
                className="nv-var"
                style={{ paddingLeft: 10 + depth * 14 }}
                onClick={() => void toggle()}
                title={v.type}
            >
                <span className={`nv-tree-caret ${open ? 'is-open' : ''} ${v.hasChildren ? '' : 'is-hidden'}`}>
                    <Icon name="chevron" size={11} />
                </span>
                <span className="nv-var-name">{v.name}</span>
                <span className="nv-var-value">{v.value}</span>
                {v.type && <span className="nv-var-type">{v.type}</span>}
            </div>
            {open && kids?.map((k) => <VarRow key={k.name} v={k} depth={depth + 1} />)}
        </>
    )
}
