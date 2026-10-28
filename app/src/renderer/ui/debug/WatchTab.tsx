import { useEffect, useState } from 'react'
import { store, useApp } from '../../state/app'
import { Icon } from '../Icon'
import { usePauseKey } from './common'

/** Watch expressions, re-evaluated at every stop. */
export function WatchTab() {
    const watches = useApp((s) => s.watches)
    const paused = useApp((s) => s.debug.state.status === 'paused')
    const key = usePauseKey()
    const [values, setValues] = useState<Record<string, { value: string; type?: string } | null>>({})
    const [draft, setDraft] = useState('')

    useEffect(() => {
        if (!paused) return
        let alive = true
        void Promise.all(
            watches.map(async (e) => [e, await window.iter.debug.evaluate(e).catch(() => null)] as const)
        ).then((pairs) => alive && setValues(Object.fromEntries(pairs)))
        return () => {
            alive = false
        }
    }, [paused, key, watches])

    const setWatches = (next: string[]): void => store.set({ watches: next })

    return (
        <div className="nv-watch">
            {watches.map((e) => (
                <div key={e} className="nv-var">
                    <span className="nv-var-name">{e}</span>
                    <span className="nv-var-value">{paused ? (values[e]?.value ?? '—') : ''}</span>
                    <button
                        className="nv-icon-btn"
                        onClick={() => setWatches(watches.filter((x) => x !== e))}
                        title="删除"
                    >
                        <Icon name="x" size={11} />
                    </button>
                </div>
            ))}
            <input
                className="nv-watch-input"
                placeholder="添加监视"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && draft.trim()) {
                        setWatches([...new Set([...watches, draft.trim()])])
                        setDraft('')
                    }
                }}
            />
            {watches.length > 1 && (
                <button className="nv-mini nv-watch-clear" onClick={() => setWatches([])}>
                    全部删除
                </button>
            )}
        </div>
    )
}
