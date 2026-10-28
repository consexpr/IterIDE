import { withKey } from '../commands/registry'
import { startDebug } from '../actions/debug'
import { runTests, stopRun } from '../actions/judge'
import { runTerminal, stopTerminal } from '../actions/terminal'
import { importFolderIntoActive } from '../actions/folders'
import { importDirect } from '../actions/tests'
import { selectedTest } from '../actions/testSelection'
import { droppedPaths, endDrag, hasFiles, routeDrop } from './shell/drop'
import { useEffect, useRef, useState } from 'react'
import type { JudgeModeInfo } from '../../shared/judgeMode'
import type { ProblemConfig } from '../../shared/problem'
import { ModeBadges } from './island/ModeBadges'
import { panelDescription } from './island/description'
import { toggleIsland } from './island/state'
import { activeFile, toast, useApp, type FileState } from '../state/app'
import { Icon } from './Icon'
import { TestList } from './TestList'
import { verdictTone } from './verdict'

export function JudgePanel() {
    const f = useApp((s) => activeFile(s), samePanelFile)
    const [over, setOver] = useState(false)
    // folders / zips / data files dropped on the panel are imported directly (no preview dialog)
    const drop = {
        onDragOver: (e: React.DragEvent) => {
            if (!hasFiles(e) || !f) return
            e.preventDefault()
            e.stopPropagation()
            setOver(true)
        },
        onDragLeave: (e: React.DragEvent) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false)
        },
        onDrop: (e: React.DragEvent) => {
            if (!hasFiles(e) || !f) return
            e.preventDefault()
            e.stopPropagation()
            setOver(false)
            endDrag()
            const paths = droppedPaths(e)
            // .cpp files (a solution, or a lone checker/interactor) keep their usual meaning
            if (paths.every((p) => /\.(cpp|cc|cxx)$/i.test(p))) return void routeDrop(paths)
            void (async () => {
                if (paths.length === 1 && (await importFolderIntoActive(paths[0], f.path))) return
                await importDirect(paths, f.path)
            })()
        }
    }
    if (!f?.problem) return <div className="nv-judge is-empty" />
    const running = f.runId !== null
    const tests = f.tests
    const compile = f.compile

    return (
        <div className={`nv-judge ${over ? 'is-drop' : ''}`} {...drop}>
            <div className="nv-judge-actions">
                {running ? (
                    <button
                        className="nv-btn is-primary"
                        onClick={() => void stopRun().catch((error: Error) => toast(error.message, 'error'))}
                    >
                        <Icon name="stop" size={14} fill /> 停止
                    </button>
                ) : (
                    <button
                        className="nv-btn is-primary"
                        onClick={() => void runTests()}
                        title={withKey('运行全部', 'run.all')}
                    >
                        <Icon name="play" size={14} fill /> 运行全部
                    </button>
                )}
                <button
                    className="nv-btn"
                    onClick={() => void runTerminal()}
                    disabled={f.terminalPending}
                    title={withKey('编译并在独立终端中运行，可直接输入数据', 'run.terminal')}
                >
                    <Icon name="terminal" size={14} /> {f.terminalPending ? '正在编译…' : '终端运行'}
                </button>
                {f.terminalRunId && (
                    <button
                        className="nv-btn is-quiet"
                        onClick={() => void stopTerminal().catch((error: Error) => toast(error.message, 'error'))}
                        title="停止终端运行"
                    >
                        <Icon name="stop" size={14} />
                    </button>
                )}
                <button
                    className="nv-btn"
                    onClick={() => void startDebug(selectedTest())}
                    title={withKey('调试', 'debug.start')}
                >
                    <Icon name="bug" size={14} /> 调试
                </button>
                <span className="nv-flex" />
                <button className="nv-btn is-quiet" onClick={toggleIsland} title={withKey('评测设置', 'app.problem')}>
                    <Icon name="sliders" size={14} />
                </button>
            </div>
            <ModeInfoBar path={f.path} problem={f.problem} />

            {!running && <JudgeSummary path={f.path} tests={tests} />}

            {compile && (compile.output.trim() || !compile.ok) && (
                <details className={`nv-compile ${compile.ok ? 'is-warn' : 'is-error'}`} open={!compile.ok}>
                    <summary>
                        {compile.ok
                            ? `编译通过，${compile.diagnostics.filter((d) => d.severity === 'warning').length} 个警告`
                            : '编译错误'}
                        <span className="nv-faint"> · {compile.cached ? '缓存' : `${compile.timeMs} ms`}</span>
                    </summary>
                    <pre>{compile.output}</pre>
                </details>
            )}

            <TestList key={f.path} file={f} />
        </div>
    )
}

/** Result events update their own cards without invalidating the whole panel's props. */
function samePanelFile(a: FileState | null, b: FileState | null): boolean {
    return (
        a === b ||
        !!(
            a &&
            b &&
            a.path === b.path &&
            a.model === b.model &&
            a.tests === b.tests &&
            a.problem === b.problem &&
            a.compile === b.compile &&
            a.runId === b.runId &&
            a.terminalRunId === b.terminalRunId &&
            a.terminalPending === b.terminalPending
        )
    )
}

function JudgeSummary({ path, tests }: { path: string; tests: FileState['tests'] }) {
    const results = useApp((s) => s.files.find((file) => file.path === path)?.results)
    if (!results) return null
    const finished = tests
        .map((test) => results[test.id])
        .filter((result) => result && !['PENDING', 'RUNNING'].includes(result.verdict))
    if (!finished.length) return null
    const passed = finished.filter((result) => result.verdict === 'AC').length
    const groups = Math.min(tests.length, 80)
    return (
        <div className="nv-summary">
            <div className="nv-summary-bar" aria-hidden="true">
                {Array.from({ length: groups }, (_, index) => {
                    const start = Math.floor((index * tests.length) / groups),
                        end = Math.floor(((index + 1) * tests.length) / groups)
                    const group = tests.slice(start, end).map((test) => results[test.id])
                    const failure = group.find(
                        (result) => result && !['AC', 'NA', 'PENDING', 'RUNNING'].includes(result.verdict)
                    )
                    const tone = failure
                        ? verdictTone(failure.verdict)
                        : group.every((result) => result?.verdict === 'AC')
                          ? 'ac'
                          : 'pending'
                    return (
                        <span
                            key={index}
                            className={`v-bg-${tone}`}
                            title={`测试点 ${start + 1}–${end}：通过 ${group.filter((result) => result?.verdict === 'AC').length} / ${group.length}`}
                        />
                    )
                })}
            </div>
            <span>
                通过 <b>{passed}</b> / {finished.length}
            </span>
            <span className="nv-faint">
                最长 {finished.reduce((max, result) => Math.max(max, result.timeMs), 0)} ms
            </span>
        </div>
    )
}

/**
 * What this file is judged with, always visible: mode, checker / interactor / grader, limits, file IO,
 * where the data comes from. Briefly highlights when the mode changes (e.g. after dropping a folder).
 */
function ModeInfoBar({ path, problem }: { path: string; problem: ProblemConfig }) {
    const [info, setInfo] = useState<JudgeModeInfo | null>(null)
    const [flash, setFlash] = useState(0)
    const lastMode = useRef<string | null>(null)
    useEffect(() => {
        let alive = true
        void window.iter.judge
            .describe(path)
            .then((i) => {
                if (!alive) return
                if (lastMode.current && lastMode.current !== i.modeId) setFlash((n) => n + 1)
                lastMode.current = i.modeId
                setInfo(i)
            })
            .catch(() => alive && setInfo(null))
        return () => {
            alive = false
        }
    }, [path, problem])
    useEffect(() => {
        lastMode.current = null
    }, [path])
    return (
        <div className="nv-modebar" key={flash} data-flash={flash > 0 ? '' : undefined}>
            <ModeBadges info={panelDescription(problem, [], info)} onClick={toggleIsland} />
        </div>
    )
}
