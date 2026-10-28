import { lazy, Suspense, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { TestResult } from '../../shared/judge'
import type { CheckerRef, TestCaseData } from '../../shared/problem'
import { startDebug } from '../actions/debug'
import { runTests } from '../actions/judge'
import { acceptOutput, deleteTests, editTest, loadIntoTest, setCompareOutput, toggleTest } from '../actions/tests'
import { loadTestPreview } from '../actions/testPreviews'
import { testById } from '../state/testCases'
import { droppedPaths, endDrag, hasFiles } from './shell/drop'
import { isDebugging, store, toast, useApp, type FileState } from '../state/app'
import { Icon } from './Icon'
import { fmtMem, verdictLabel, verdictTone } from './verdict'
import { showWhitespace } from './whitespace'
import { testTextPreview } from './testTextPreview'
const OutputComparison = lazy(() =>
    import('./OutputComparison').then((module) => ({ default: module.OutputComparison }))
)

interface TestCardProps {
    file: FileState
    test: TestCaseData
    index: number
}

export const TestCard = memo(
    function TestCard({ file, test: initialTest, index }: TestCardProps) {
        const test = useApp((s) => {
            const current = s.files?.find((row) => row.path === file.path)
            return current ? (testById(current.tests, initialTest.id) ?? initialTest) : initialTest
        })
        const key = `${file.path}#${test.id}`
        const expanded = useApp((s) => s.expanded[key] ?? false)
        const focused = useApp((s) => s.focused === key)
        const r: TestResult | undefined = useApp((s) => {
            const current = s.files?.find((row) => row.path === file.path)
            return (current ?? file).results[test.id]
        })
        const [previewError, setPreviewError] = useState<string | null>(null)
        const previewRequest = useRef(0)
        const loadPreview = (): void => {
            const request = ++previewRequest.current
            setPreviewError(null)
            void loadTestPreview(file.path, test.id).catch((error: Error) => {
                if (request === previewRequest.current) setPreviewError(error.message)
            })
        }
        useEffect(() => {
            if (expanded && test.previewLoaded === false) loadPreview()
            return () => {
                previewRequest.current++
            }
        }, [expanded, file.path, test])
        const tone = r ? verdictTone(r.verdict) : 'pending'
        const busy = r?.verdict === 'RUNNING'
        const metadataBusy = useApp(
            (s) =>
                s.closing ||
                s.files?.find((row) => row.path === file.path)?.transitioning === true ||
                (s.debug?.path === file.path && isDebugging(s))
        )
        const [compareSaving, setCompareSaving] = useState(false)
        const comparisonDisabled = compareSaving || !!file.runId || !!file.terminalRunId || metadataBusy
        const compareOutput = test.compareOutput !== false
        const changeComparison = async (enabled: boolean): Promise<void> => {
            setCompareSaving(true)
            try {
                await setCompareOutput(test.id, enabled, file.path)
            } catch (error) {
                toast((error as Error).message, 'error')
            } finally {
                setCompareSaving(false)
            }
        }

        const toggle = (): void => store.set((s) => ({ expanded: { ...s.expanded, [key]: !expanded }, focused: key }))

        return (
            <div
                className={`nv-test ${expanded ? 'is-open' : ''} ${focused ? 'is-focused' : ''} ${test.enabled ? '' : 'is-disabled'}`}
                data-verdict={r?.verdict ?? 'NONE'}
            >
                <div
                    className="nv-test-head"
                    data-test-toggle
                    role="button"
                    tabIndex={0}
                    aria-expanded={expanded}
                    aria-label={`测试点 ${test.name}`}
                    onClick={toggle}
                    onKeyDown={(event) => {
                        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                            event.preventDefault()
                            toggle()
                        }
                    }}
                >
                    <input
                        type="checkbox"
                        checked={test.enabled}
                        disabled={metadataBusy}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) =>
                            void toggleTest(test.id, e.target.checked, file.path).catch((error: Error) =>
                                toast(error.message, 'error')
                            )
                        }
                        title="参与「运行全部」"
                    />
                    <span className="nv-test-index">#{index + 1}</span>
                    <span className="nv-test-name">{test.name !== String(index + 1) ? test.name : ''}</span>
                    {test.sample && <span className="nv-chip is-faint">样例</span>}
                    <span className="nv-flex" />
                    {r && r.verdict !== 'PENDING' && (
                        <span className="nv-test-stats">
                            {r.verdict !== 'RUNNING' && <span>{r.timeMs} ms</span>}
                            {r.memoryKb !== undefined && <span>{fmtMem(r.memoryKb)}</span>}
                        </span>
                    )}
                    {r && (
                        <span className={`nv-verdict v-${tone}`} title={verdictLabel(r.verdict).long}>
                            {busy ? <span className="nv-breath" /> : verdictLabel(r.verdict).short}
                        </span>
                    )}
                    <span className="nv-test-tools" onClick={(e) => e.stopPropagation()}>
                        <button
                            className="nv-icon-btn"
                            onClick={() => void runTests([test.id], file.path)}
                            title="只运行这个"
                        >
                            <Icon name="play" size={13} />
                        </button>
                        <button
                            className="nv-icon-btn"
                            onClick={() => void startDebug(test.id, file.path)}
                            title="用这个测试点调试"
                        >
                            <Icon name="bug" size={13} />
                        </button>
                        <button
                            className="nv-icon-btn"
                            disabled={metadataBusy}
                            onClick={() =>
                                void deleteTests([test.id], file.path).catch((error: Error) =>
                                    toast(error.message, 'error')
                                )
                            }
                            title="删除"
                        >
                            <Icon name="trash" size={13} />
                        </button>
                    </span>
                    <span className={`nv-test-caret ${expanded ? 'is-open' : ''}`}>
                        <Icon name="chevronDown" size={14} />
                    </span>
                </div>

                {expanded && (
                    <div className="nv-test-body">
                        {test.previewLoaded === false ? (
                            <div className="nv-faint" role="status">
                                {previewError ? (
                                    <>
                                        读取测试数据失败：{previewError}{' '}
                                        <button className="nv-mini" onClick={loadPreview}>
                                            重试
                                        </button>
                                    </>
                                ) : (
                                    '正在读取测试数据…'
                                )}
                            </div>
                        ) : (
                            <div className="nv-io-grid">
                                <IOBox
                                    label="输入"
                                    value={test.input}
                                    truncated={test.truncated}
                                    size={test.inputSize}
                                    disabled={metadataBusy}
                                    onChange={(v) => editTest(test.id, { input: v }, file.path)}
                                    onFile={(p) => void loadIntoTest(test.id, 'input', p, file.path)}
                                />
                                <IOBox
                                    label="期望输出"
                                    value={test.answer}
                                    truncated={test.truncated}
                                    size={test.answerSize}
                                    disabled={metadataBusy}
                                    controls={
                                        <label
                                            className="nv-compare-output"
                                            title={
                                                file.problem?.mode === 'interactive'
                                                    ? '交互模式仍由交互器驱动并检查协议；成功运行标记为未比较'
                                                    : '关闭后仅运行并保留输出，不与期望输出比较；已有答案会保留'
                                            }
                                        >
                                            <input
                                                type="checkbox"
                                                checked={compareOutput}
                                                disabled={comparisonDisabled}
                                                aria-label={`测试点 ${test.name} 比较输出`}
                                                onChange={(event) => void changeComparison(event.target.checked)}
                                            />
                                            比较输出
                                        </label>
                                    }
                                    onChange={(v) => editTest(test.id, { answer: v }, file.path)}
                                    onFile={(p) => void loadIntoTest(test.id, 'answer', p, file.path)}
                                />
                                <OutputBox
                                    label="实际输出"
                                    text={r?.output ?? ''}
                                    expected={compareOutput ? test.answer : undefined}
                                    verdict={r?.verdict}
                                    truncated={r?.truncated}
                                    expectedTruncated={test.truncated}
                                    checker={
                                        file.problem && ['standard', 'grader'].includes(file.problem.mode)
                                            ? file.problem.checker
                                            : undefined
                                    }
                                >
                                    {r && r.output && r.verdict !== 'AC' && (
                                        <button
                                            className="nv-mini"
                                            onClick={() => void acceptOutput(test.id, file.path)}
                                            title="把实际输出设为期望输出"
                                        >
                                            设为期望
                                        </button>
                                    )}
                                </OutputBox>
                                <OutputBox label="cerr" text={r?.stderr ?? ''} tone="err" />
                            </div>
                        )}
                        {r?.checkerMessage && <div className={`nv-checker v-${tone}`}>{r.checkerMessage}</div>}
                        {r?.interactorLog && (
                            <details className="nv-interactor">
                                <summary>交互库日志</summary>
                                <pre>{r.interactorLog}</pre>
                            </details>
                        )}
                        {r && r.exitCode !== null && r.exitCode !== 0 && (
                            <div className="nv-checker v-re">
                                退出码 {r.exitCode}
                                {exitHint(r.exitCode)}
                            </div>
                        )}
                    </div>
                )}
            </div>
        )
    },
    (a, b) =>
        a.test === b.test &&
        a.index === b.index &&
        a.file.path === b.file.path &&
        a.file.problem === b.file.problem &&
        a.file.runId === b.file.runId &&
        a.file.terminalRunId === b.file.terminalRunId
)

function exitHint(code: number): string {
    const c = code >>> 0
    if (c === 0xc0000005) return '（访问越界 / 段错误）'
    if (c === 0xc00000fd) return '（栈溢出，递归太深？）'
    if (c === 0xc0000094) return '（整数除以零）'
    if (code === 3 || c === 0xc0000409) return '（abort / assert 失败）'
    if (code === 139) return '（SIGSEGV 段错误）'
    if (code === 134) return '（SIGABRT）'
    if (code === 136) return '（SIGFPE 除零）'
    return ''
}

function IOBox(props: {
    label: string
    value: string
    truncated: boolean
    size: number
    onChange: (v: string) => void
    onFile: (path: string) => void
    controls?: React.ReactNode
    disabled?: boolean
}) {
    const ref = useRef<HTMLTextAreaElement>(null)
    const [over, setOver] = useState(false)
    const preview = useMemo(() => testTextPreview(props.value), [props.value])
    const readOnly = props.truncated || preview.truncated
    useLayoutEffect(() => {
        autosize(ref.current)
    }, [preview.text])
    // a text file dropped here replaces this box (instead of the panel-wide data import)
    const drop = {
        onDragOver: (e: React.DragEvent) => {
            if (!hasFiles(e)) return
            e.preventDefault()
            e.stopPropagation()
            setOver(true)
        },
        onDragLeave: () => setOver(false),
        onDrop: (e: React.DragEvent) => {
            if (!hasFiles(e)) return
            e.preventDefault()
            e.stopPropagation()
            setOver(false)
            endDrag()
            const [path] = droppedPaths(e)
            if (path) props.onFile(path)
        }
    }
    return (
        <div className={`nv-io ${over ? 'is-drop' : ''}`} {...drop}>
            <div className="nv-io-label">
                <span>{props.label}</span>
                {props.controls}
                {preview.truncated ? (
                    <span className="nv-faint">内容较长，仅显示开头，只读预览</span>
                ) : props.truncated ? (
                    <span className="nv-faint">{(props.size / 1024).toFixed(0)} KB · 已截断，只读</span>
                ) : null}
                <CopyBtn text={props.value} />
            </div>
            <textarea
                ref={ref}
                className="nv-io-text"
                spellCheck={false}
                wrap="off"
                disabled={props.disabled}
                value={preview.text}
                readOnly={readOnly}
                onChange={(e) => props.onChange(e.target.value)}
                onPaste={(event) => {
                    if (readOnly || props.disabled) return
                    const element = event.currentTarget
                    const pasted = event.clipboardData.getData('text/plain')
                    const value =
                        props.value.slice(0, element.selectionStart) + pasted + props.value.slice(element.selectionEnd)
                    if (!testTextPreview(value).truncated) return
                    // Save the complete edit without letting the browser lay out the full paste first.
                    event.preventDefault()
                    props.onChange(value)
                }}
            />
        </div>
    )
}

function OutputBox(props: {
    label: string
    text: string
    expected?: string
    verdict?: string
    truncated?: boolean
    expectedTruncated?: boolean
    checker?: CheckerRef
    tone?: 'err'
    children?: React.ReactNode
}) {
    const [whitespace, setWhitespace] = useState(false)
    const preview = useMemo(() => testTextPreview(props.text), [props.text])
    const display = useMemo(() => {
        const text = preview.text.replace(/\r\n/g, '\n')
        return whitespace ? showWhitespace(text) : text
    }, [preview.text, whitespace])
    const showDiff =
        props.expected !== undefined && props.verdict && !['AC', 'NA', 'PENDING', 'RUNNING'].includes(props.verdict)
    return (
        <div className={`nv-io is-output ${showDiff ? 'has-comparison' : ''} ${props.tone === 'err' ? 'is-err' : ''}`}>
            <div className="nv-io-label">
                <span>{props.label}</span>
                {(props.truncated || preview.truncated) && <span className="nv-faint">仅显示开头</span>}
                {props.children}
                {props.text && <CopyBtn text={props.text} />}
            </div>
            <pre className="nv-io-text">{display}</pre>
            {showDiff && (
                <Suspense
                    fallback={
                        <p className="nv-faint" role="status">
                            正在加载输出对比…
                        </p>
                    }
                >
                    <OutputComparison
                        actual={props.text}
                        expected={props.expected!}
                        checker={props.checker}
                        truncated={props.truncated || props.expectedTruncated}
                        whitespace={whitespace}
                        onWhitespace={setWhitespace}
                    />
                </Suspense>
            )}
        </div>
    )
}

function CopyBtn({ text }: { text: string }) {
    return (
        <button className="nv-mini is-icon" onClick={() => void navigator.clipboard.writeText(text)} title="复制">
            <Icon name="copy" size={12} />
        </button>
    )
}

function autosize(el: HTMLTextAreaElement | null): void {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight + 2, 260)}px`
}
