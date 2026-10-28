// Direct controls share one compact panel. Mode changes animate only the relevant contents.
import { useState } from 'react'
import type { JudgeModeInfo, JudgeModeSummary } from '../../../shared/judgeMode'
import { normalRunMode, runModeChoice, selectedCheckerKind } from '../../../shared/checkerSelection'
import type { ProblemSettingsPatch } from '../../../shared/problem'
import { editProblemSettings } from '../../actions/tests'
import { detectFreopen, insertFreopen } from '../../editor/freopen'
import { syncFileIO } from '../../actions/fileIO'
import { activeFile, isDebugging, store, toast, useApp } from '../../state/app'
import { Icon } from '../Icon'
import { useAsyncResource } from '../AsyncContent'
import { useContentMotion } from '../motion'
import { closeIsland } from './state'
import { CheckerKindButtons, CheckerSettings } from './CheckerSettings'
import { useControlMotion } from './controlMotion'

const BUILTIN_MODES: JudgeModeSummary[] = [
    { id: 'standard', name: '普通', source: 'builtin' },
    { id: 'interactive', name: '交互', source: 'builtin' }
]
const base = (p?: string): string => (p ? (p.split(/[\\/]/).pop() ?? p) : '未设置')

export function EvalPanel() {
    const f = useApp((s) => activeFile(s))
    const p = f?.problem
    const path = f?.path
    const [linkFor, setLinkFor] = useState<string | null>(null)
    const linkOpen = path !== undefined && linkFor === path
    const busy = useApp((s) => {
        const file = activeFile(s)
        return !!(
            s.closing ||
            file?.transitioning ||
            file?.runId ||
            file?.terminalRunId ||
            file?.terminalPending ||
            (s.debug.path === file?.path && isDebugging(s))
        )
    })
    const available = useAsyncResource('judge-modes', () => window.iter.judge.modes())
    const modes = available.data?.length
        ? available.data.filter((m) => !['spj', 'grader'].includes(m.id))
        : BUILTIN_MODES
    const description = useAsyncResource<JudgeModeInfo | null>(
        path,
        () => (path ? window.iter.judge.describe(path) : Promise.resolve(null)),
        [p]
    )
    const mode = p ? runModeChoice(p) : undefined
    const content = useContentMotion(mode + ':' + (p ? selectedCheckerKind(p) : ''))
    const ioContent = useContentMotion(p?.fileIO.enabled)
    const controls = useControlMotion(mode)
    if (!f || !p) return null
    const interactive = mode === 'interactive'
    const io = p.fileIO
    const set = (patch: ProblemSettingsPatch): void => editProblemSettings(f.path, patch)
    const run = (job: Promise<void>): void => {
        void job.catch((error: Error) => toast(error.message, 'error'))
    }
    const writeToCode = (): void => {
        if (isDebugging()) return toast('调试结束后才能插入代码', 'info')
        const code = f.model.getValue()
        if (detectFreopen(code).input) return toast('代码里已有 freopen', 'info')
        const next = insertFreopen(code, io.input, io.output)
        if (!next) return toast('没找到 int main()', 'error')
        f.model.pushEditOperations([], [{ range: f.model.getFullModelRange(), text: next }], () => null)
    }
    return (
        <div className="nvi-panel" onClick={(event) => event.stopPropagation()}>
            <div ref={controls} className="nvi-bar">
                <fieldset className="nvi-controls nvi-mode-controls" disabled={busy}>
                    <div className="nvi-seg nvi-run-kind" role="group" aria-label="运行方式">
                        {modes.map((m) => (
                            <button
                                key={m.id}
                                className={mode === m.id ? 'is-on' : ''}
                                aria-pressed={mode === m.id}
                                onClick={() => set({ mode: m.id === 'standard' ? normalRunMode(p) : m.id })}
                            >
                                {m.id === 'standard' ? '普通' : m.id === 'interactive' ? '交互' : m.name}
                            </button>
                        ))}
                    </div>
                    {mode === 'standard' && <CheckerKindButtons sourcePath={f.path} problem={p} />}
                    {interactive && <span className="nvi-checker-note">由交互器判定</span>}
                </fieldset>
                <span className="nvi-check-status">
                    {description.pending && (
                        <span className="nv-loading-mark" role="status" aria-label="正在检查评测文件…" />
                    )}
                    {description.error && (
                        <span className="nvi-description-error" title={description.error} role="status">
                            !
                        </span>
                    )}
                </span>
                <button
                    className="nvi-x"
                    aria-label="题目链接"
                    aria-expanded={linkOpen}
                    title={p.url || '题目链接'}
                    onClick={() => setLinkFor(linkOpen ? null : f.path)}
                >
                    <Icon name="link" size={13} />
                </button>
                <button className="nvi-x" onClick={closeIsland} aria-label="收起">
                    <Icon name="x" size={13} />
                </button>
            </div>
            <fieldset className="nvi-controls nvi-settings-body" disabled={busy}>
                <div ref={content} className="nvi-mode-content">
                    {mode === 'standard' && (
                        <CheckerSettings
                            sourcePath={f.path}
                            problem={p}
                            protocol={
                                !description.pending
                                    ? description.data?.badges.find((b) => b.label === '协议')
                                    : undefined
                            }
                        />
                    )}
                    {interactive && (
                        <div className="nvi-file">
                            <span>交互器</span>
                            <code title={p.interactor?.path}>
                                {p.interactor?.path ? base(p.interactor.path) : '未设置交互器'}
                            </code>
                            {p.interactor?.files?.length ? (
                                <span className="nvi-tag">{p.interactor.files.length + 1} 个文件</span>
                            ) : null}
                            <button
                                onClick={() => store.set({ dialog: { kind: 'interactorCode', sourcePath: f.path } })}
                            >
                                {p.interactor?.path ? '编辑' : '设置'}
                            </button>
                        </div>
                    )}
                    {p.grader && ['standard', 'interactive'].includes(mode!) && (
                        <div className="nvi-file">
                            <span>联合编译</span>
                            <code title={p.grader.sources.join('\n')}>{p.grader.sources.map(base).join(' + ')}</code>
                        </div>
                    )}
                </div>
                <div className="nvi-params">
                    <label className="nvi-field">
                        <span>时间</span>
                        <input
                            type="number"
                            min={1}
                            value={p.timeLimit}
                            onChange={(e) => set({ timeLimit: Math.max(1, +e.target.value) })}
                        />
                        <em>ms</em>
                    </label>
                    <label className="nvi-field">
                        <span>内存</span>
                        <input
                            type="number"
                            min={1}
                            value={p.memoryLimit}
                            onChange={(e) => set({ memoryLimit: Math.max(1, +e.target.value) })}
                        />
                        <em>MB</em>
                    </label>
                    <label
                        className="nvi-toggle"
                        title={
                            interactive ? '交互模式使用标准输入输出；文件 IO 设置会保留，切回普通运行后恢复' : undefined
                        }
                    >
                        <input
                            type="checkbox"
                            checked={!interactive && io.enabled}
                            disabled={interactive}
                            onChange={(e) => set({ fileIO: { ...io, enabled: e.target.checked, origin: 'manual' } })}
                        />
                        <span>文件 IO</span>
                    </label>
                </div>
                <div ref={ioContent} className="nvi-io">
                    {!interactive && io.enabled && (
                        <>
                            <input
                                aria-label="输入文件名"
                                value={io.input}
                                onChange={(e) => set({ fileIO: { ...io, input: e.target.value, origin: 'manual' } })}
                            />
                            <span className="nvi-arrow">→</span>
                            <input
                                aria-label="输出文件名"
                                value={io.output}
                                onChange={(e) => set({ fileIO: { ...io, output: e.target.value, origin: 'manual' } })}
                            />
                            <button
                                onClick={() => run(syncFileIO(f.path, f.model.getValue(), p, true))}
                                title="从代码里的 freopen 读取"
                            >
                                识别
                            </button>
                            <button onClick={writeToCode} title="在 main 开头插入 freopen">
                                插入
                            </button>
                        </>
                    )}
                </div>
                {linkOpen && (
                    <input
                        aria-label="题目链接"
                        value={p.url ?? ''}
                        placeholder="https://"
                        onChange={(e) => set({ url: e.target.value || undefined })}
                    />
                )}
            </fieldset>
        </div>
    )
}
