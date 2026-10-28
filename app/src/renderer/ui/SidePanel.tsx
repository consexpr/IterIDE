import { lazy, Suspense, useEffect, useState } from 'react'
import type { PanelInfo } from '../../shared/plugin'
import { store, useApp, type RightView } from '../state/app'
import { JudgePanel } from './JudgePanel'
import { PluginPanel, panelKey } from './plugins/PluginPanel'
const DebugPanel = lazy(() => import('./debug/DebugPanel').then((module) => ({ default: module.DebugPanel })))
const SnapshotPanel = lazy(() => import('./SnapshotPanel').then((module) => ({ default: module.SnapshotPanel })))

const BUILTIN: { id: RightView; label: string }[] = [
    { id: 'tests', label: '测试' },
    { id: 'debug', label: '调试' },
    { id: 'snapshots', label: '快照' }
]

/** Plugin-contributed side pages; refreshed when plugins load / reload. */
function usePluginPanels(): PanelInfo[] {
    const [panels, setPanels] = useState<PanelInfo[]>([])
    useEffect(() => {
        const load = (): void =>
            void window.iter.plugins
                .panels()
                .then(setPanels)
                .catch(() => setPanels([]))
        load()
        return window.iter.plugins.onChanged(load)
    }, [])
    return panels
}

/** Everything except the code lives in this one column, so the editor keeps the width. */
export function SidePanel() {
    const view = useApp((s) => s.rightView)
    const debugActive = useApp((s) => s.debug.state.status !== 'idle')
    const badges = useApp((s) => s.pluginBadges)
    const panels = usePluginPanels()
    // plugin frames stay mounted once opened so they keep their own state
    const [opened, setOpened] = useState<Set<string>>(new Set())
    useEffect(() => {
        if (view.startsWith('plugin:') && !opened.has(view)) setOpened(new Set(opened).add(view))
    }, [view, opened])
    // a removed plugin's tab can't stay selected
    useEffect(() => {
        if (view.startsWith('plugin:') && !panels.some((p) => panelKey(p) === view)) store.set({ rightView: 'tests' })
    }, [panels, view])

    return (
        <aside className="nv-side" data-view={view}>
            <div className="nv-side-tabs">
                {BUILTIN.map((v) => (
                    <button
                        key={v.id}
                        className={view === v.id ? 'is-on' : ''}
                        onClick={() => store.set({ rightView: v.id })}
                    >
                        {v.label}
                        {v.id === 'debug' && debugActive && <span className="nv-dot is-running" />}
                    </button>
                ))}
                {panels.length > 0 && <span className="nv-side-sep" />}
                {panels.map((p) => {
                    const key = panelKey(p)
                    return (
                        <button
                            key={key}
                            className={`is-plugin ${view === key ? 'is-on' : ''}`}
                            onClick={() => store.set({ rightView: key as RightView })}
                            title={p.pluginId}
                        >
                            {p.title}
                            {badges[key] && <span className="nv-tab-badge">{badges[key]}</span>}
                        </button>
                    )
                })}
            </div>
            {view === 'tests' && <JudgePanel />}
            {view === 'snapshots' && (
                <Suspense
                    fallback={
                        <p className="nv-panel-loading" role="status">
                            正在加载快照…
                        </p>
                    }
                >
                    <SnapshotPanel />
                </Suspense>
            )}
            {view === 'debug' && (
                <Suspense
                    fallback={
                        <p className="nv-panel-loading" role="status">
                            正在加载调试面板…
                        </p>
                    }
                >
                    <DebugPanel />
                </Suspense>
            )}
            {panels
                .filter((p) => opened.has(panelKey(p)) || view === panelKey(p))
                .map((p) => (
                    <PluginPanel key={panelKey(p)} panel={p} visible={view === panelKey(p)} />
                ))}
        </aside>
    )
}
