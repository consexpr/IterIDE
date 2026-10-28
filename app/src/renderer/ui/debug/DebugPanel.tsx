// Debug panel: variables / watch / stack / breakpoints pages, program output docked below.
import { useEffect, useRef, useState } from 'react'
import { debugSessionToken, scheduleDebugSeek, setDebugTab } from '../../actions/debug'
import { useApp, type DebugTab } from '../../state/app'
import { BreakpointsTab } from './BreakpointsTab'
import { OutputDock } from './OutputDock'
import { StackTab } from './StackTab'
import { VariablesTab } from './VariablesTab'
import { WatchTab } from './WatchTab'
import { recordedState, recordingNotice } from './presentation'

const TABS: { id: DebugTab; label: string }[] = [
    { id: 'variables', label: '变量' },
    { id: 'watch', label: '监视' },
    { id: 'stack', label: '调用栈' },
    { id: 'breakpoints', label: '断点' }
]

export function DebugPanel() {
    const tab = useApp((s) => s.debug.tab)
    const st = useApp((s) => s.debug.state)
    const testName = useApp((s) => {
        const f = s.files.find((x) => x.path === s.debug.path)
        const i = f?.tests.findIndex((t) => t.id === s.debug.testId) ?? -1
        return i >= 0 ? `#${i + 1}` : '无输入'
    })
    const bpCount = useApp((s) => Object.values(s.breakpoints).reduce((n, b) => n + b.length, 0))
    const notice = recordingNotice(st)

    return (
        <div className="nv-debug">
            <div className="nv-debug-status">
                <span>测试点 {testName}</span>
                <span className="nv-faint">
                    {st.status === 'paused' && `第 ${st.line ?? '?'} 行${st.frame ? ` · 栈帧 #${st.frame}` : ''}`}
                    {st.status === 'exited' && `已退出（${st.exitCode ?? '?'}）`}
                    {st.status === 'running' && '运行中'}
                    {st.status === 'recording' && `录制 ${st.steps} 步`}
                    {st.status === 'starting' && '编译'}
                    {st.status === 'idle' && '—'}
                    {st.status === 'error' && '出错'}
                </span>
            </div>
            {st.status === 'error' && <pre className="nv-debug-error">{st.message}</pre>}
            {notice && (
                <div className="nv-debug-note" role="status">
                    {notice}
                </div>
            )}
            <Timeline />
            <div className="nv-dtabs">
                {TABS.map((t) => (
                    <button key={t.id} className={tab === t.id ? 'is-on' : ''} onClick={() => setDebugTab(t.id)}>
                        {t.label}
                        {t.id === 'breakpoints' && bpCount > 0 && <span className="nv-dtab-count">{bpCount}</span>}
                    </button>
                ))}
            </div>
            <div className="nv-dpage">
                {tab === 'variables' && <VariablesTab />}
                {tab === 'watch' && <WatchTab />}
                {tab === 'stack' && <StackTab />}
                {tab === 'breakpoints' && <BreakpointsTab />}
            </div>
            <OutputDock />
        </div>
    )
}

/** Replay timeline: drag to any recorded step. */
function Timeline() {
    const st = useApp((s) => s.debug.state)
    const [drag, setDrag] = useState<number | null>(null)
    const cancelSeek = useRef<(() => void) | null>(null)
    const session = debugSessionToken()
    const at = recordedState(st)
    useEffect(() => {
        cancelSeek.current?.()
        setDrag(null)
    }, [session])
    useEffect(() => () => cancelSeek.current?.(), [])
    if (!at) return null
    const max = at.totalSteps - 1
    const value = Math.max(0, Math.min(max, drag ?? at.stepIndex))
    const interactive = at.status === 'paused' || at.status === 'exited'
    const move = (v: number): void => {
        if (!interactive) return
        setDrag(v)
        // one seek per frame while dragging
        cancelSeek.current?.()
        cancelSeek.current = scheduleDebugSeek(v)
    }
    return (
        <div className="nv-timeline">
            <input
                type="range"
                min={0}
                max={max}
                disabled={!interactive}
                aria-label="调试记录步骤"
                value={value}
                style={{ '--pct': `${(value / max) * 100}%` } as React.CSSProperties}
                onChange={(e) => move(+e.target.value)}
                onPointerUp={() => setDrag(null)}
                onKeyUp={() => setDrag(null)}
            />
            <span className="nv-timeline-at">
                {value + 1} / {at.totalSteps}
            </span>
        </div>
    )
}
