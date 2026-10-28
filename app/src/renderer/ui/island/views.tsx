import { EvalPanel } from './EvalPanel'
import { withKey } from '../../commands/registry'
// What the island shows in each state. Pure view functions: state in, content out.
import type { DebugCommand, DebugState } from '../../../shared/debug'
import type { Verdict } from '../../../shared/judge'
import type { ProblemConfig } from '../../../shared/problem'
import { selectedCheckerKind, runModeChoice } from '../../../shared/checkerSelection'
import { debugCommand, runToCursor } from '../../actions/debug'
import { Icon, type IconName } from '../Icon'
import { fmtMem, verdictLabel, verdictTone } from '../verdict'

export interface IslandView {
    /** Changing key crossfades the content. */
    key: string
    /** `auto`: an expanded panel whose height follows its content. */
    height: number | 'auto'
    /** Fixed width (expanded panels); otherwise the content's natural width. */
    width?: number
    node: React.ReactNode
    /** Visual variant hook for CSS (`data-tone`). */
    tone?: string
    onClick?: () => void
}

const fmtTL = (ms: number): string => (ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`)

export function emptyView(): IslandView {
    return { key: 'empty', height: 30, node: <span className="nvi-cutout" /> }
}

export function panelView(): IslandView {
    return { key: 'panel', height: 'auto', width: 420, node: <EvalPanel /> }
}

export function idleView(name: string, p: ProblemConfig, last: Verdict | null, onClick: () => void): IslandView {
    return {
        key: `idle:${last ?? ''}`,
        height: 30,
        onClick,
        node: (
            <div className="nvi-row">
                {last && <span className={`nvi-led v-${verdictTone(last)}`} />}
                <span className="nvi-title">{name}</span>
                <span className="nvi-meta">
                    {fmtTL(p.timeLimit)} · {p.memoryLimit}MB
                </span>
                {p.mode === 'interactive' ? (
                    <span className="nvi-tag">交互</span>
                ) : runModeChoice(p) === 'standard' && selectedCheckerKind(p) === 'custom' ? (
                    <span className="nvi-tag">checker</span>
                ) : null}
                {p.grader && <span className="nvi-tag">grader</span>}
                {!['standard', 'spj', 'grader', 'interactive'].includes(p.mode) && (
                    <span className="nvi-tag">{p.mode}</span>
                )}
                {p.mode !== 'interactive' && p.fileIO.enabled && <span className="nvi-tag">IO</span>}
            </div>
        )
    }
}

export function compilingView(): IslandView {
    return {
        key: 'compiling',
        height: 30,
        node: (
            <div className="nvi-row">
                <span className="nvi-led is-busy" />
                <span className="nvi-title">编译中</span>
            </div>
        )
    }
}

export function runningView(done: number, total: number, failed: number): IslandView {
    return {
        key: 'running',
        height: 30,
        node: (
            <div className="nvi-row nvi-split">
                <Ring progress={total ? done / total : 0} bad={failed > 0} />
                <span className="nvi-count">
                    {done}
                    <span className="nvi-dim">/{total}</span>
                </span>
            </div>
        )
    }
}

export function resultView(v: Verdict, passed: number, total: number, maxTime: number, maxMemKb?: number): IslandView {
    const tone = verdictTone(v)
    const label = v === 'AC' ? '全部通过' : v === 'CE' ? '编译错误' : verdictLabel(v).long
    return {
        key: `result:${v}`,
        height: 56,
        tone,
        node: (
            <div className="nvi-result">
                <span className={`nvi-badge v-${tone}`}>
                    <Icon name={v === 'AC' ? 'check' : v === 'CE' ? 'terminal' : 'x'} size={18} />
                </span>
                <div className="nvi-result-text">
                    <span className={`nvi-result-title v-${tone}`}>{label}</span>
                    {v !== 'CE' && (
                        <span className="nvi-result-sub">
                            {passed}/{total} · 最长 {maxTime} ms{maxMemKb !== undefined ? ` · ${fmtMem(maxMemKb)}` : ''}
                        </span>
                    )}
                </div>
            </div>
        )
    }
}

/** `k / N` for a finished recording, `k` while it is still growing (1-based). */
const stepLabel = (st: DebugState): string => {
    if (st.status !== 'paused' && st.status !== 'exited') return ''
    const k = st.stepIndex + 1
    return st.recordingComplete ? `${k} / ${st.totalSteps}` : `${k}`
}

export function debugView(st: DebugState): IslandView {
    const paused = st.status === 'paused'
    const ended = st.status === 'exited'
    const crash = paused && st.reason === 'signal'
    const btn = (cmd: DebugCommand, icon: IconName, title: string, enabled = paused) => (
        <button key={cmd} className="nvi-btn" disabled={!enabled} onClick={() => debugCommand(cmd)} title={title}>
            <Icon name={icon} size={16} />
        </button>
    )
    const where =
        st.status === 'starting' ? (
            <span className="nvi-title">编译</span>
        ) : st.status === 'recording' ? (
            <>
                <span className="nvi-title">录制</span>
                <span className="nvi-line-sub">{st.steps} 步</span>
            </>
        ) : ended ? (
            <>
                <span className="nvi-title">结束</span>
                <span className="nvi-line-sub">
                    返回 {st.exitCode ?? '?'} · {stepLabel(st)}
                </span>
            </>
        ) : st.status === 'running' ? (
            <span className="nvi-title">运行中</span>
        ) : paused ? (
            <>
                <span className="nvi-line">{st.line ?? '?'}</span>
                <span className="nvi-line-sub">
                    {crash ? `${st.signal ?? '信号'} · ${stepLabel(st)}` : stepLabel(st)}
                </span>
            </>
        ) : null
    return {
        key: 'debug',
        height: 48,
        tone: crash ? 'crash' : 'debug',
        node: (
            <div className="nvi-debug">
                <div className="nvi-debug-where">
                    <span
                        className={`nvi-led ${st.status === 'starting' || st.status === 'recording' ? 'is-busy' : paused || ended ? 'is-paused' : 'is-live'}`}
                    />
                    {where}
                </div>
                <div className="nvi-debug-ctrl">
                    {btn('stepBack', 'stepBack', withKey('上一步', 'debug.back'), (paused || ended) && st.canStepBack)}
                    {paused
                        ? btn('continue', 'continue', withKey('继续', 'debug.start'))
                        : btn('pause', 'stop', '暂停', st.status === 'running')}
                    {btn('stepOver', 'stepOver', withKey('下一行', 'debug.next'))}
                    {btn('stepIn', 'stepIn', withKey('步入', 'debug.in'))}
                    {btn('stepOut', 'stepOut', withKey('步出', 'debug.out'))}
                    <button
                        className="nvi-btn"
                        disabled={!paused}
                        onClick={() => void runToCursor()}
                        title={withKey('执行到光标处', 'debug.runToCursor')}
                    >
                        <Icon name="toCursor" size={16} />
                    </button>
                    <span className="nvi-sep" />
                    {btn('restart', 'restart', withKey('重新开始', 'debug.restart'), true)}
                    <button
                        className="nvi-btn is-stop"
                        onClick={() => debugCommand('stop')}
                        title={withKey('结束', 'debug.stop')}
                    >
                        <Icon name="x" size={16} />
                    </button>
                </div>
            </div>
        )
    }
}

/** Progress ring that fills; it never spins. */
function Ring({ progress, bad = false }: { progress: number; bad?: boolean }) {
    const r = 7
    const c = 2 * Math.PI * r
    return (
        <svg className={`nvi-ring ${bad ? 'is-bad' : ''}`} width="18" height="18" viewBox="0 0 18 18">
            <circle cx="9" cy="9" r={r} className="nvi-ring-track" />
            <circle
                cx="9"
                cy="9"
                r={r}
                className="nvi-ring-fill"
                strokeDasharray={c}
                strokeDashoffset={c * (1 - progress)}
            />
        </svg>
    )
}
