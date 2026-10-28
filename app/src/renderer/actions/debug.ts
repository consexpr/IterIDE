import type { Breakpoint, DebugCommand, DebugEvent, DebugState } from '../../shared/debug'
import { editorRef } from '../editor/instance'
import { monaco } from '../editor/monaco'
import { activeFile, emptyDebug, isDebugging, store, toast, type DebugTab } from '../state/app'
import { activate, autoPersist, isFileTransitioning } from './files'
import { flushProblemWrites } from './problemWrites'
import { stopRun } from './judge'
import { syncFileIO } from './fileIO'
import { BreakpointTracker, type BreakpointFormatSnapshot } from '../editor/breakpointTracking'
import { createDebugHoverProvider } from '../editor/debugHover'
import { DebugStepGate } from '../editor/debugStepGate'

const api = window.iter
const MAX_STREAM = 200_000
let debugGeneration = 0
let debugTail = Promise.resolve()
let stdoutOffset = -1,
    stderrOffset = -1
let navigationEpoch = 0,
    sessionEpoch = 0
let lastPause: string | null = null
let lastPauseNavigation = -1
const stepGate = new DebugStepGate()
export const debugSessionToken = (): number => sessionEpoch

function navigate(newSession = false): void {
    stepGate.invalidate()
    void editorRef.editor
        ?.getAction('editor.action.hideHover')
        ?.run()
        .catch(() => {})
    navigationEpoch++
    if (newSession) {
        sessionEpoch++
        lastPause = null
    }
}
function pauseKey(state: DebugState): string | null {
    return state.status === 'paused'
        ? JSON.stringify([sessionEpoch, state.stepIndex, state.file, state.line, state.frame, state.reason])
        : null
}

export function listenDebug(): void {
    api.debug.onEvent((e: DebugEvent) => {
        const d = store.get().debug
        switch (e.type) {
            case 'stdout':
                store.set({ debug: { ...d, stdout: (d.stdout + e.text).slice(-MAX_STREAM) } })
                break
            case 'stderr':
                store.set({ debug: { ...d, stderr: (d.stderr + e.text).slice(-MAX_STREAM) } })
                break
            case 'output':
                // replay: the panes show exactly what the program had printed up to this step
                store.set({ debug: { ...d, stdout: e.stdout.slice(-MAX_STREAM), stderr: e.stderr.slice(-MAX_STREAM) } })
                stdoutOffset = e.stdoutOffset ?? -1
                stderrOffset = e.stderrOffset ?? -1
                break
            case 'output-delta': {
                const stdout = e.resetStdout
                    ? (e.stdout ?? '')
                    : e.stdoutOffset >= stdoutOffset
                      ? d.stdout + (e.stdout ?? '')
                      : d.stdout
                const stderr = e.resetStderr
                    ? (e.stderr ?? '')
                    : e.stderrOffset >= stderrOffset
                      ? d.stderr + (e.stderr ?? '')
                      : d.stderr
                stdoutOffset = e.resetStdout ? e.stdoutOffset : Math.max(stdoutOffset, e.stdoutOffset)
                stderrOffset = e.resetStderr ? e.stderrOffset : Math.max(stderrOffset, e.stderrOffset)
                store.set({ debug: { ...d, stdout: stdout.slice(-MAX_STREAM), stderr: stderr.slice(-MAX_STREAM) } })
                break
            }
            case 'recording':
                if (e.done && (e.limited === 'steps' || e.limited === 'time'))
                    toast(`录制上限 ${e.steps} 步 · 之后实时调试`, 'info', 5000)
                if (e.done && ['output', 'trace', 'nodes'].includes(e.limited ?? ''))
                    toast('调试资源达到上限，已停止程序并保留录制内容', 'info', 6000)
                break
            case 'breakpoints':
                store.set({ debug: { ...d, bpInfo: e.breakpoints } })
                break
            case 'state': {
                const key = pauseKey(e.state)
                const metadataOnly = key !== null && key === lastPause
                const newNavigation = lastPauseNavigation !== navigationEpoch
                lastPause = key
                lastPauseNavigation = navigationEpoch
                store.set({ debug: { ...d, state: e.state } })
                if (!metadataOnly) void onState()
                else if (newNavigation) void refreshPaused()
                break
            }
        }
    })
}

async function onState(): Promise<void> {
    const st = store.get().debug.state
    lockEditor(isDebugging())
    if (st.status === 'paused') {
        if (st.file && st.file !== store.get().activePath && store.get().files.some((f) => f.path === st.file))
            activate(st.file)
        revealLine(st.line)
        await refreshPaused()
    } else {
        clearLine()
        // no frame once the program has ended: don't leave an earlier stop's values on screen
        if (st.status === 'exited') store.set((s) => ({ debug: { ...s.debug, locals: [], stack: [] } }))
    }
    // a replay keeps the session at its end (shown in the island); a live run is simply over
    if (st.status === 'exited' && st.mode !== 'replay')
        toast(`程序已退出，返回值 ${st.exitCode ?? '?'}`, st.exitCode === 0 ? 'success' : 'error')
    if (st.status === 'error') toast(st.message.slice(0, 400), 'error', 8000)
}

/** Re-read what the panel shows for the current stop / selected frame. */
async function refreshPaused(): Promise<void> {
    const state = store.get().debug.state,
        frame = store.get().debug.frame
    if (state.status !== 'paused') return
    const key = pauseKey(state),
        navigation = navigationEpoch
    const [locals, stack] = await Promise.all([api.debug.locals().catch(() => []), api.debug.stack().catch(() => [])])
    if (
        navigationEpoch !== navigation ||
        pauseKey(store.get().debug.state) !== key ||
        store.get().debug.frame !== frame
    )
        return
    store.set((s) => ({ debug: { ...s.debug, locals, stack } }))
}

export function startDebug(testId?: string, sourcePath = store.get().activePath): Promise<void> {
    const f = store.get().files.find((file) => file.path === sourcePath)
    if (!f?.problem || store.get().closing || isFileTransitioning(f.path)) return Promise.resolve()
    navigate(true)
    const generation = ++debugGeneration
    // Capture this dependency before appending this start, avoiding circular waits with run's stop.
    const stopJudging = stopRun(f.path).then(
        () => ({ ok: true as const }),
        (error) => ({ ok: false as const, error })
    )
    const starting = (): void => {
        store.set((s) => ({
            debug: {
                ...emptyDebug(),
                state: { status: 'starting' },
                path: f.path,
                testId: testId ?? null,
                tab: s.debug.tab
            },
            rightView: 'debug'
        }))
        lockEditor(true)
    }
    starting()
    const current = (): boolean =>
        generation === debugGeneration && store.get().files.some((file) => file.model === f.model)
    const job = debugTail
        .catch(() => {})
        .then(async () => {
            if (!current()) return
            await api.debug.command('stop')
            const stopped = await stopJudging
            if (!stopped.ok) throw stopped.error
            if (!current()) return
            await flushProblemWrites(f.path)
            if (!current() || f.model.isDisposed()) return
            starting()
            await autoPersist(f.path)
            if (!current() || f.model.isDisposed()) return
            const code = f.model.getValue()
            const config = store.get().files.find((file) => file.model === f.model)?.problem
            if (config) await syncFileIO(f.path, code, config)
            if (!current() || f.model.isDisposed()) return
            await flushProblemWrites(f.path)
            if (!current() || f.model.isDisposed()) return
            const problem = store.get().files.find((file) => file.model === f.model)?.problem
            const id = testId ?? problem?.tests.find((t) => t.enabled)?.id
            store.set((s) => ({ debug: { ...s.debug, testId: id ?? null } }))
            breakpointTrackers.get(f.model)?.tracker.sync()
            const bps = store.get().breakpoints[f.path] ?? []
            stdoutOffset = stderrOffset = -1
            await api.debug.start({
                sourcePath: f.path,
                source: code,
                testId: id,
                input: id ? undefined : '',
                breakpoints: bps,
                stopAtEntry: !bps.some((b) => b.enabled)
            })
        })
        .catch((e) => {
            if (!current()) return
            store.set((s) => ({ debug: { ...s.debug, state: { status: 'error', message: (e as Error).message } } }))
            lockEditor(false)
            toast(`调试启动失败：${(e as Error).message}`, 'error', 6000)
        })
    debugTail = job
    return job
}

/** Jump to any recorded step (timeline). */
export function seekDebug(index: number, expectedNavigation = navigationEpoch): void {
    const state = store.get().debug.state
    if (expectedNavigation !== navigationEpoch || !['paused', 'exited'].includes(state.status)) return
    navigate()
    void api.debug.seek(index).catch((e: Error) => toast(e.message, 'error'))
}

/** A delayed animation frame belongs to the navigation which scheduled it. */
export function scheduleDebugSeek(index: number): () => void {
    const expected = navigationEpoch
    const frame = requestAnimationFrame(() => seekDebug(index, expected))
    return () => cancelAnimationFrame(frame)
}

export function debugCommand(cmd: DebugCommand): void {
    if (!isDebugging() && cmd !== 'restart') return
    if (cmd === 'stepOver' || cmd === 'next' || cmd === 'stepIn' || cmd === 'stepOut' || cmd === 'stepBack') {
        const key = cmd === 'next' ? 'stepOver' : cmd
        if (stepGate.isBusy(key)) return
        navigate()
        stepGate.run(
            key,
            () => api.debug.command(cmd),
            (error) => toast(error instanceof Error ? error.message : String(error), 'error')
        )
        return
    }
    if (cmd === 'stop') {
        void stopDebug().catch((error: Error) => toast(error.message, 'error'))
    } else {
        navigate(cmd === 'restart')
        void api.debug.command(cmd).catch((e: Error) => toast(e.message, 'error'))
    }
}

export function stopDebug(): Promise<void> {
    navigate(true)
    const generation = ++debugGeneration
    const previous = debugTail
    // Send stop now: waiting for startup first can wait forever for the first breakpoint.
    const command = api.debug.command('stop')
    const job = Promise.all([previous.catch(() => {}), command]).then(() => {
        if (generation !== debugGeneration) return
        store.set((s) => ({ debug: { ...emptyDebug(), tab: s.debug.tab } }))
        lockEditor(false)
        clearLine()
    })
    debugTail = job
    return job
}

/** Continue only (unlike F5, which also starts a session). */
export function continueDebug(): void {
    if (store.get().debug.state.status === 'paused') debugCommand('continue')
}

/** Run to the editor's cursor line; starts debugging first when idle (like Red Panda). */
export async function runToCursor(): Promise<void> {
    const f = activeFile()
    const line = editorRef.editor?.getPosition()?.lineNumber
    if (!f || !line) return
    if (!isDebugging()) {
        await startDebug()
        await waitPaused()
    }
    if (store.get().debug.state.status !== 'paused') return
    navigate()
    await api.debug.runToCursor(f.path, line).catch((e: Error) => toast(e.message, 'error'))
}

async function waitPaused(ms = 20000): Promise<void> {
    const end = Date.now() + ms
    while (Date.now() < end && !['paused', 'exited', 'error'].includes(store.get().debug.state.status))
        await new Promise((r) => setTimeout(r, 100))
}

export async function selectFrame(level: number): Promise<void> {
    navigate()
    await api.debug.selectFrame(level).catch((e: Error) => toast(e.message, 'error'))
    const frame = store.get().debug.stack.find((s) => s.level === level)
    if (frame?.line && frame.file === store.get().debug.path) {
        revealLine(frame.line, level > 0)
    }
    store.set((s) => ({ debug: { ...s.debug, frame: level } }))
    await refreshPaused()
}

export const setDebugTab = (tab: DebugTab): void =>
    store.set((s) => ({ debug: { ...s.debug, tab }, rightView: 'debug' }))

/** Add a watch expression (Red Panda "Add Watch"): the word under the cursor or the selection. */
export function addWatchFromEditor(): void {
    const ed = editorRef.editor
    const model = ed?.getModel()
    const sel = ed?.getSelection()
    if (!ed || !model || !sel) return
    const text = sel.isEmpty() ? model.getWordAtPosition(sel.getPosition())?.word : model.getValueInRange(sel)
    if (!text?.trim()) return
    store.set((s) => ({ watches: [...new Set([...s.watches, text.trim()])] }))
    setDebugTab('watch')
}

// ---- breakpoints (editor list is the source of truth; gdb gets a copy while debugging) ----
function publishBreakpoints(path: string, next: Breakpoint[]): void {
    const sorted = [...next].sort((a, b) => a.line - b.line)
    store.set((s) => ({ breakpoints: { ...s.breakpoints, [path]: sorted } }))
    if (isDebugging())
        void api.debug.setBreakpoints(path, sorted).catch((error: Error) => toast(error.message, 'error'))
}
function writeBreakpoints(path: string, next: Breakpoint[]): void {
    publishBreakpoints(path, next)
    renderBreakpoints(path)
}

export function toggleBreakpoint(line: number): void {
    const f = activeFile()
    if (!f) return
    const bps = store.get().breakpoints[f.path] ?? []
    writeBreakpoints(
        f.path,
        bps.some((b) => b.line === line) ? bps.filter((b) => b.line !== line) : [...bps, { line, enabled: true }]
    )
}

export function updateBreakpoint(path: string, line: number, patch: Partial<Breakpoint>): void {
    const bps = store.get().breakpoints[path] ?? []
    const exists = bps.some((b) => b.line === line)
    writeBreakpoints(
        path,
        exists
            ? bps.map((b) => (b.line === line ? { ...b, ...patch } : b))
            : [...bps, { line, enabled: true, ...patch }]
    )
}

export function removeBreakpoint(path: string, line: number): void {
    writeBreakpoints(
        path,
        (store.get().breakpoints[path] ?? []).filter((b) => b.line !== line)
    )
}

export function clearAllBreakpoints(): void {
    for (const path of Object.keys(store.get().breakpoints)) writeBreakpoints(path, [])
}

/** "断点属性": open the breakpoints tab focused on the cursor line (creating the breakpoint). */
export function editBreakpointAtCursor(): void {
    const line = editorRef.editor?.getPosition()?.lineNumber
    if (line) editBreakpointAtLine(line)
}

export function editBreakpointAtLine(line: number): void {
    const f = activeFile()
    if (!f) return
    if (!(store.get().breakpoints[f.path] ?? []).some((b) => b.line === line)) updateBreakpoint(f.path, line, {})
    store.set((s) => ({
        debug: { ...s.debug, tab: 'breakpoints', editBreakpoint: `${f.path}#${line}` },
        rightView: 'debug'
    }))
}

// ---- editor decorations ----
let lineDecos: monaco.editor.IEditorDecorationsCollection | null = null
const breakpointTrackers = new Map<monaco.editor.ITextModel, { path: string; tracker: BreakpointTracker }>()

export function renderBreakpoints(path = store.get().activePath): void {
    const file = store.get().files.find((item) => item.path === path)
    if (!file || file.model.isDisposed()) return
    const values = store.get().breakpoints[file.path] ?? []
    let entry = breakpointTrackers.get(file.model)
    if (!entry && !values.length) return
    if (!entry) {
        entry = {
            path: file.path,
            tracker: new BreakpointTracker(
                file.model,
                (next) => publishBreakpoints(file.path, next),
                () => breakpointTrackers.delete(file.model)
            )
        }
        breakpointTrackers.set(file.model, entry)
    }
    entry.tracker.set(values)
}

export function beginBreakpointFormatting(
    path: string,
    model: monaco.editor.ITextModel
): { tracker: BreakpointTracker; snapshot: BreakpointFormatSnapshot } | null {
    renderBreakpoints(path)
    const tracker = breakpointTrackers.get(model)?.tracker
    return tracker ? { tracker, snapshot: tracker.beginFormat() } : null
}
export function finishBreakpointFormatting(work: ReturnType<typeof beginBreakpointFormatting>): void {
    if (!work) return
    const invalid = work.tracker.finishFormat(work.snapshot)
    if (invalid.length)
        toast(`格式化后无法确认第 ${invalid.join('、')} 行的原语句，已停用断点，请重新设置`, 'info', 6000)
}

function revealLine(line?: number, outerFrame = false): void {
    const ed = editorRef.editor
    const d = store.get().debug
    if (!ed || !line) return clearLine()
    if (d.path && store.get().activePath !== d.path) return
    lineDecos ??= ed.createDecorationsCollection()
    lineDecos.set([
        {
            range: new monaco.Range(line, 1, line, 1),
            options: {
                isWholeLine: true,
                className: outerFrame ? 'nv-debug-line is-frame' : 'nv-debug-line',
                glyphMarginClassName: 'nv-debug-arrow'
            }
        }
    ])
    ed.revealLineInCenterIfOutsideViewport(line, 0)
}

function clearLine(): void {
    lineDecos?.clear()
}

function lockEditor(locked: boolean): void {
    editorRef.editor?.updateOptions({ readOnly: locked || store.get().closing, readOnlyMessage: { value: '调试中' } })
    editorRef.lang?.setHoverEnabled(!locked)
}

/** While paused, hovering an expression shows its live value. */
export function registerDebugHover(): void {
    monaco.languages.registerHoverProvider(
        'cpp',
        createDebugHoverProvider({
            editor: () => editorRef.editor,
            pause: () => {
                const { debug, activePath } = store.get()
                return debug.state.status === 'paused'
                    ? JSON.stringify([navigationEpoch, sessionEpoch, pauseKey(debug.state), debug.frame, activePath])
                    : null
            },
            inspect: (expression) => api.debug.inspect(expression)
        })
    )
}
