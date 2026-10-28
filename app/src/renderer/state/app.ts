import type { Breakpoint, BreakpointInfo, DebugState, StackFrame, Variable } from '../../shared/debug'
import type { ImportPreview, ProblemFolderPreview } from '../../shared/importer'
import type { CompileResult, TestResult, Verdict } from '../../shared/judge'
import type { ProblemConfig, TestCaseData } from '../../shared/problem'
import { defaultSettings, type AppSettings } from '../../shared/settings'
import type { monaco } from '../editor/monaco'
import { load, save } from '../util/storage'
import { Store, useStore } from './store'

export interface FileState {
    path: string
    name: string
    /** N of an `Untitled-N` tab (its file is app-managed until the first save). */
    untitled?: number
    /** The file was deleted or moved away behind our back; the buffer is all that is left. */
    missing: boolean
    /** Identity migration owns problem metadata while the text buffer may still be edited. */
    transitioning?: boolean
    model: monaco.editor.ITextModel
    savedVersion: number
    /** Text of the last save / load, LF-normalised. */
    savedText: string
    dirty: boolean
    problem: ProblemConfig | null
    tests: TestCaseData[]
    results: Record<string, TestResult>
    compile: CompileResult | null
    runId: string | null
    terminalRunId: string | null
    terminalPending: boolean
    /** Overall verdict of the latest run (for tab / explorer badges). */
    lastVerdict: Verdict | null
    viewState: monaco.editor.ICodeEditorViewState | null
}

export type Dialog =
    | { kind: 'settings' }
    | { kind: 'import'; preview: ImportPreview; sourcePath: string }
    | { kind: 'pickSource'; problem: ProblemFolderPreview }
    | { kind: 'checkerCode'; sourcePath: string }
    | { kind: 'interactorCode'; sourcePath: string }

export interface Toast {
    id: number
    text: string
    kind: 'info' | 'success' | 'error'
}

/** Pages of the debug panel (Red Panda's debug window tabs). */
export type DebugTab = 'variables' | 'watch' | 'stack' | 'breakpoints'

export interface DebugSession {
    state: DebugState
    path: string | null
    testId: string | null
    stdout: string
    stderr: string
    locals: Variable[]
    stack: StackFrame[]
    /** Selected stack frame. */
    frame: number
    tab: DebugTab
    /** gdb's view of the breakpoints (hit counts, verification) and data breakpoints. */
    bpInfo: BreakpointInfo[]
    /** `path#line` of the breakpoint whose properties are being edited. */
    editBreakpoint: string | null
}

/** Built-in side views, or `plugin:<pluginId>/<panelId>` for plugin-contributed pages. */
export type RightView = 'tests' | 'debug' | 'snapshots' | `plugin:${string}`

export interface AppState {
    closing: boolean
    ready: boolean
    settings: AppSettings
    files: FileState[]
    activePath: string | null
    breakpoints: Record<string, Breakpoint[]>
    debug: DebugSession
    dialog: Dialog | null
    toasts: Toast[]
    lspStatus: 'starting' | 'clangd' | 'fallback'
    rightView: RightView
    /** Test cards whose bodies are expanded. */
    expanded: Record<string, boolean>
    dragOver: boolean
    /** `path#testId` of the test card last clicked (debug target). */
    focused: string | null
    /** Bumped when user themes reload, so theme pickers re-render. */
    themeVersion: number
    /** The dynamic island is expanded into the judge-settings panel. */
    islandOpen: boolean
    /** Side panel collapsed (editor takes the full width). */
    sideCollapsed: boolean
    /** Small badges plugin panels put on their tab (`setBadge`). */
    pluginBadges: Record<string, string | null>
    /** Sign-in / sync page is shown. */
    accountOpen: boolean
    /** Watch expressions (kept across sessions). */
    watches: string[]
}

export const emptyDebug = (): DebugSession => ({
    state: { status: 'idle' },
    path: null,
    testId: null,
    stdout: '',
    stderr: '',
    locals: [],
    stack: [],
    frame: 0,
    tab: 'variables',
    bpInfo: [],
    editBreakpoint: null
})

export const store = new Store<AppState>({
    closing: false,
    ready: false,
    settings: defaultSettings(),
    files: [],
    activePath: null,
    breakpoints: {},
    debug: emptyDebug(),
    dialog: null,
    toasts: [],
    lspStatus: 'starting',
    rightView: 'tests',
    expanded: {},
    dragOver: false,
    focused: null,
    themeVersion: 0,
    islandOpen: false,
    sideCollapsed: false,
    pluginBadges: {},
    accountOpen: false,
    watches: load<string[]>('iter.watches', [])
})

// watches survive restarts (per machine)
let persistedWatches = store.get().watches
store.subscribe(() => {
    const watches = store.get().watches
    if (watches === persistedWatches) return
    persistedWatches = watches
    save('iter.watches', watches)
})

export const useApp = <T>(sel: (s: AppState) => T, equal?: (a: T, b: T) => boolean): T => useStore(store, sel, equal)

export function activeFile(s: AppState = store.get()): FileState | null {
    return s.files.find((f) => f.path === s.activePath) ?? null
}

export function updateFile(path: string, patch: Partial<FileState> | ((f: FileState) => Partial<FileState>)): void {
    store.set((s) => ({
        files: s.files.map((f) => (f.path === path ? { ...f, ...(typeof patch === 'function' ? patch(f) : patch) } : f))
    }))
}

let toastId = 0
export function toast(text: string, kind: Toast['kind'] = 'info', ms = 3600): void {
    const id = ++toastId
    store.set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }))
    setTimeout(() => store.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms)
}

/** A session is open until stopped; a replayed run that reached its end can still step back. */
export const isDebugging = (s: AppState = store.get()): boolean => {
    const st = s.debug.state
    if (st.status === 'exited') return st.mode === 'replay' && st.canStepBack
    return !['idle', 'error'].includes(st.status)
}
