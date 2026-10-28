// Hot exit: the open tabs, unsaved buffers included, are written regularly and on quit, and
// brought back on the next start, so closing the app never asks and never loses an edit.
import { sanitizeViewState, type SessionData, type SessionTab } from '../../shared/session'
import { store, toast } from '../state/app'
import { activate, checkAllExternal, restoreTab } from './files'
import { editorRef } from '../editor/instance'
import { sessionHealth } from '../state/sessionHealth'

const INTERVAL_MS = 10_000
let last: SessionData | undefined
const snapshots = new WeakMap<object, { version: number; view: string; tab: SessionTab }>()
let saveTail = Promise.resolve()
let sessionTimer: ReturnType<typeof setInterval> | undefined
let sessionRunning = false
let sessionPaused = false

export function sessionSnapshot(): SessionData {
    const s = store.get()
    return {
        version: 1,
        active: s.activePath,
        tabs: s.files.map((f) => {
            const version = f.model.getAlternativeVersionId()
            const previous = snapshots.get(f.model)
            const liveView = editorRef.editor?.getModel() === f.model ? editorRef.editor.saveViewState() : f.viewState
            const viewState = sanitizeViewState(liveView)
            const view = JSON.stringify(viewState) ?? ''
            if (
                previous &&
                previous.version === version &&
                previous.view === view &&
                previous.tab.path === f.path &&
                previous.tab.saved === f.savedText &&
                previous.tab.untitled === f.untitled &&
                !!previous.tab.missing === !!f.missing
            )
                return previous.tab
            const tab: SessionTab = {
                path: f.path,
                ...(f.untitled === undefined ? {} : { untitled: f.untitled }),
                ...(f.missing ? { missing: true } : {}),
                text: previous?.version === version ? previous.tab.text : f.model.getValue(),
                saved: f.savedText,
                ...(viewState ? { viewState } : {})
            }
            snapshots.set(f.model, { version, view, tab })
            return tab
        })
    }
}

export function saveSessionNow(): Promise<void> {
    const snapshot = sessionSnapshot()
    const job = saveTail
        .catch(() => {})
        .then(async () => {
            if (
                last &&
                snapshot.active === last.active &&
                snapshot.tabs.length === last.tabs.length &&
                snapshot.tabs.every((tab, index) => tab === last!.tabs[index])
            ) {
                sessionHealth.set({ error: null })
                return
            }
            try {
                await window.iter.session.save(snapshot)
                last = snapshot
                sessionHealth.set({ error: null })
            } catch (error) {
                sessionHealth.set({ error: error instanceof Error ? error.message : String(error) })
                throw error
            }
        })
    saveTail = job
    return job
}

export function pauseSessionSaving(): void {
    sessionPaused = true
    clearInterval(sessionTimer)
    sessionTimer = undefined
}

export function resumeSessionSaving(): void {
    sessionPaused = false
    if (!sessionRunning || sessionTimer !== undefined) return
    sessionTimer = setInterval(() => {
        void saveSessionNow().catch(() => {})
    }, INTERVAL_MS)
}

export async function restoreSession(): Promise<void> {
    const api = window.iter
    const session = await api.session.load()
    await api.fs
        .sweepUntitled(session?.tabs.flatMap((t) => (t.untitled === undefined ? [] : [t.path])) ?? [])
        .catch(() => {})
    if (!session) return
    const first = session.tabs.find((tab) => tab.path === session.active)
    const ordered = first ? [first, ...session.tabs.filter((tab) => tab !== first)] : session.tabs
    for (const [index, tab] of ordered.entries()) {
        try {
            await restoreTab(tab)
            if (index === 0 && first) activate(first.path)
        } catch (e) {
            toast(`无法恢复 ${tab.path}：${(e as Error).message}`, 'error')
        }
        // Paint the active tab before restoring background tabs; keep admission behind finishStartup().
        if (index + 1 < ordered.length) await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const order = new Map(session.tabs.map((tab, index) => [tab.path, index]))
    store.set((s) => ({
        files: [...s.files].sort((a, b) => (order.get(a.path) ?? Infinity) - (order.get(b.path) ?? Infinity))
    }))
    last = undefined
}

/** Call once the previous session is back; writing earlier would replace it with an empty one. */
export function startSession(): () => void {
    sessionRunning = true
    if (!sessionPaused) resumeSessionSaving()
    const onFocus = (): void => {
        void checkAllExternal()
    }
    window.addEventListener('focus', onFocus)
    return () => {
        sessionRunning = false
        clearInterval(sessionTimer)
        sessionTimer = undefined
        window.removeEventListener('focus', onFocus)
    }
}
