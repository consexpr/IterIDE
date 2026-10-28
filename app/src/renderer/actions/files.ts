import { editorRef } from '../editor/instance'
import { monaco } from '../editor/monaco'
import { applyModelIndentation } from '../editor/indentation'
import { isModelDirty } from '../editor/dirty'
import type { SessionTab } from '../../shared/session'
import { activeFile, store, toast, updateFile, type FileState } from '../state/app'
import { flushProblemWrites, forgetProblemWrites, overlayProblemWrites } from './problemWrites'
import { FileOperations, fileKey } from './fileOperations'

export { fileKey } from './fileOperations'

const api = window.iter
const CPP = /\.(cpp|cc|cxx)$/i
const operations = new FileOperations<FileState['model']>()
const { opening, closing, saving } = operations
/** Untitled numbers handed out but not yet visible in the store. */
const reserved = new Set<number>()
const creating = new Set<Promise<void>>()

export function isFileClosing(path: string): boolean {
    const file = store.get().files.find((file) => fileKey(file.path) === fileKey(path))
    return !!file && closing.has(operations.owner(file.model))
}

export function isFileTransitioning(path: string): boolean {
    const file = store.get().files.find((file) => fileKey(file.path) === fileKey(path))
    return (
        !!file && (closing.has(operations.owner(file.model)) || operations.migrating.has(operations.owner(file.model)))
    )
}

/** Serialize buffer-related work with saves, Save As and closing this tab. */
export function withFileOperation<T>(
    file: FileState,
    action: (current: FileState) => Promise<T>
): Promise<T | undefined> {
    return serial(file.model, () => {
        const current = store.get().files.find((item) => item.model === operations.current(file.model))
        return current && !current.model.isDisposed() ? action(current) : Promise.resolve(undefined)
    })
}

/** Include accepted opens and identity migrations in the final session snapshot. */
export async function flushFileOperations(): Promise<void> {
    while (opening.size || creating.size || saving.size || closing.size)
        await Promise.all([...opening.values(), ...creating, ...saving.values(), ...closing.values()])
}

export const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p
export const dirName = (p: string): string => p.replace(/[\\/][^\\/]*$/, '')
/** The editor holds LF; compare disk and snapshot text on the same footing. */
const normalize = (text: string): string => text.replace(/\r\n?/g, '\n')

/** Open the system file dialog and open every chosen C++ file. */
export async function openFilesDialog(): Promise<void> {
    for (const p of await api.fs.openFileDialog({ filters: [{ name: 'C++', extensions: ['cpp', 'cc', 'cxx'] }] }))
        await openFile(p)
}

export function openFile(path: string): Promise<void> {
    if (store.get().closing) return Promise.resolve()
    const key = fileKey(path)
    const migrating = operations.targets.get(key)
    if (migrating) return Promise.resolve(operations.pendingSave(migrating)).then(() => openFile(path))
    const existing = store.get().files.find((f) => fileKey(f.path) === key)
    if (existing) {
        activate(existing.path)
        return Promise.resolve()
    }
    const pending = opening.get(key)
    if (pending) return pending
    const job = doOpenFile(path).finally(() => {
        if (opening.get(key) === job) opening.delete(key)
    })
    opening.set(key, job)
    return job
}

interface FileInit {
    /** The last saved text; the tab is unsaved while the buffer differs. */
    saved: string
    /** The live buffer, when it is not the saved text (restored sessions). */
    text?: string
    untitled?: number
    missing?: boolean
}

/** Build the tab and its model; callers add it to the store. */
function createFile(path: string, init: FileInit): FileState {
    const uri = monaco.Uri.file(path)
    const saved = normalize(init.saved)
    const known = monaco.editor.getModel(uri)
    known?.setValue(saved)
    const model = known ?? monaco.editor.createModel(saved, 'cpp', uri)
    applyModelIndentation(model, store.get().settings.editor)
    model.setEOL(monaco.editor.EndOfLineSequence.LF)
    const savedVersion = model.getAlternativeVersionId()
    if (init.text !== undefined && normalize(init.text) !== saved) model.setValue(normalize(init.text))
    model.onDidChangeContent(() => {
        const f = store.get().files.find((x) => x.model === model)
        if (!f) return
        const dirty = isModelDirty(model, f.savedVersion, f.savedText)
        if (f.dirty !== dirty) updateFile(f.path, { dirty })
    })
    return {
        path,
        name: init.untitled === undefined ? baseName(path) : `Untitled-${init.untitled}`,
        ...(init.untitled === undefined ? {} : { untitled: init.untitled }),
        missing: init.missing ?? false,
        model,
        savedVersion,
        savedText: saved,
        dirty: model.getAlternativeVersionId() !== savedVersion,
        problem: null,
        tests: [],
        results: {},
        compile: null,
        runId: null,
        terminalRunId: null,
        terminalPending: false,
        lastVerdict: null,
        viewState: null
    }
}

/** Add a tab, bring up its judge data and show it. */
async function mountFile(file: FileState, show = true): Promise<void> {
    store.set((st) => ({ files: [...st.files, file] }))
    editorRef.lang?.attach(file.model, file.path)
    if (show) activate(file.path)
    await reloadProblem(file.path)
}

async function doOpenFile(path: string): Promise<void> {
    if (!CPP.test(path)) {
        toast('仅支持 .cpp', 'info')
        return
    }
    let text: string
    try {
        text = await api.fs.readText(path)
    } catch (e) {
        toast(`无法打开 ${path}: ${(e as Error).message}`, 'error')
        return
    }
    const existing = store.get().files.find((f) => fileKey(f.path) === fileKey(path))
    if (existing) return activate(existing.path)
    await mountFile(createFile(path, { saved: text }))
    rememberRecent(path)
}

/** A new `Untitled-N` tab on the template. It is a real file in the app's folder, so run / debug work unsaved. */
export function newUntitled(): Promise<void> {
    if (store.get().closing) return Promise.resolve()
    const used = new Set([
        ...store.get().files.flatMap((f) => (f.untitled === undefined ? [] : [f.untitled])),
        ...reserved
    ])
    let index = 1
    while (used.has(index)) index++
    reserved.add(index)
    const job = createUntitled(index).finally(() => {
        reserved.delete(index)
        creating.delete(job)
    })
    creating.add(job)
    return job
}

async function createUntitled(index: number): Promise<void> {
    try {
        const template = store.get().settings.template
        const cursorAt = template.indexOf('$0'),
            text = template.replace('$0', '')
        const path = await api.fs.createUntitled(index, text)
        const file = createFile(path, { saved: text, untitled: index })
        await mountFile(file)
        const ed = editorRef.editor
        if (ed?.getModel() === file.model && cursorAt >= 0) {
            const pos = file.model.getPositionAt(cursorAt)
            ed.setPosition(pos)
            ed.revealPositionInCenter(pos)
        }
    } catch (e) {
        toast(`无法新建文件：${(e as Error).message}`, 'error')
    }
}

/** Re-open a tab recorded by the last session, unsaved edits included. */
export async function restoreTab(tab: SessionTab): Promise<void> {
    const key = fileKey(tab.path)
    const pending = opening.get(key)
    if (pending) await pending
    if (store.get().files.some((file) => fileKey(file.path) === key)) return
    const restore = doRestoreTab(tab)
    opening.set(key, restore)
    try {
        await restore
    } finally {
        if (opening.get(key) === restore) opening.delete(key)
    }
}

async function doRestoreTab(tab: SessionTab): Promise<void> {
    if (tab.untitled !== undefined) {
        // The buffer in the session is the truth; the managed file only has to exist for judge / debug.
        await api.fs.writeText(tab.path, tab.text).catch(() => {})
        await mountFile(
            {
                ...createFile(tab.path, { saved: tab.saved, text: tab.text, untitled: tab.untitled }),
                viewState: tab.viewState ?? null
            },
            false
        )
        return
    }
    const exists = await api.fs.exists(tab.path)
    const file = createFile(tab.path, { saved: tab.saved, text: tab.text, missing: tab.missing || !exists })
    file.viewState = tab.viewState ?? null
    await mountFile(file, false)
    if (exists) await checkExternal(tab.path)
}

export async function reloadProblem(path: string): Promise<void> {
    const owner = store.get().files.find((file) => fileKey(file.path) === fileKey(path))
    const sourcePath = owner?.path ?? path
    try {
        const [problem, tests] = await Promise.all([
            api.problem.load(sourcePath),
            api.problem.listTests ? api.problem.listTests(sourcePath) : api.problem.readTests(sourcePath)
        ])
        if (owner && !store.get().files.some((file) => file.model === owner.model)) return
        updateFile(sourcePath, overlayProblemWrites(sourcePath, problem, tests))
        // Importing a grader/interactor can replace the cached header paths of an already open document.
        void api.lsp.refreshCompileFlags(sourcePath).catch(() => {})
    } catch (e) {
        toast(`评测配置读取失败：${(e as Error).message}`, 'error')
    }
}

export function activate(path: string): void {
    const s = store.get()
    path = s.files.find((file) => fileKey(file.path) === fileKey(path))?.path ?? path
    const ed = editorRef.editor
    const prev = activeFile(s)
    if (prev && ed && prev.path !== path) updateFile(prev.path, { viewState: ed.saveViewState() })
    store.set({ activePath: path })
    const next = store.get().files.find((f) => f.path === path)
    if (ed && next) {
        ed.setModel(next.model)
        if (next.viewState) ed.restoreViewState(next.viewState)
        ed.focus()
    }
}

/** Move the existing tab before another tab (null means the end), keeping its model and active editor. */
export function moveFile(path: string, beforePath: string | null): void {
    const state = store.get()
    if (state.closing || path === beforePath) return
    const file = state.files.find((item) => item.path === path)
    if (!file) return
    const files = state.files.filter((item) => item !== file)
    const to = beforePath === null ? files.length : files.findIndex((item) => item.path === beforePath)
    // A tab may have closed or changed identity while it was being dragged.
    if (to < 0) return
    files.splice(to, 0, file)
    if (files.some((item, index) => item !== state.files[index])) store.set({ files })
}

/** Keep open models and their unsaved edits while returning to the welcome page. */
export function showHome(): void {
    const current = activeFile()
    const editor = editorRef.editor
    if (current && editor) updateFile(current.path, { viewState: editor.saveViewState() })
    store.set({ activePath: null, islandOpen: false, accountOpen: false, dialog: null })
    editor?.setModel(null)
}

/** One save at a time per tab, in request order. */
function serial<T>(model: FileState['model'], job: () => Promise<T>): Promise<T> {
    return operations.serial(model, job)
}

/**
 * Write the buffer to the tab's own file. An untitled tab only refreshes its managed copy, so it
 * stays unsaved; everything else becomes clean.
 */
export function persistFile(path = store.get().activePath, confirmOverwrite = false): Promise<void> {
    const f = path ? store.get().files.find((x) => fileKey(x.path) === fileKey(path)) : undefined
    if (!f || f.missing) return Promise.resolve()
    return serial(f.model, () => {
        const current = store.get().files.find((file) => file.model === operations.current(f.model))
        return current ? writeBuffer(current, confirmOverwrite) : Promise.resolve()
    })
}

async function writeBuffer(f: FileState, confirmOverwrite = false): Promise<void> {
    if (f.untitled !== undefined) {
        if (!f.model.isDisposed()) await api.fs.writeText(f.path, f.model.getValue())
        return
    }
    if (store.get().settings.editor.formatOnSave) await (await import('./format')).formatOnSaveHook(f.path, f.model)
    if (f.model.isDisposed()) return
    const version = f.model.getAlternativeVersionId()
    const code = f.model.getValue()
    await api.fs.writeText(f.path, code, { expected: f.savedText, confirmOverwrite })
    if (f.model.isDisposed()) return
    if (store.get().files.some((file) => file.path === f.path && file.model === f.model))
        updateFile(f.path, {
            savedVersion: version,
            savedText: code,
            missing: false,
            dirty: isModelDirty(f.model, version, code)
        })
    // keeps the file's identity and the backup snapshot in ~/.iter current; never blocks saving
    void api.problem.saved(f.path, code).catch(() => {})
}

/** Before something reads the file from disk: write the buffer if it is not there yet. */
export async function autoPersist(path: string): Promise<void> {
    const f = store.get().files.find((x) => x.path === path)
    if (f && f.dirty && (f.untitled !== undefined || store.get().settings.autoSave)) await persistFile(path)
}

/** The user's save. Untitled tabs ask where to put the file. Resolves to the tab's path, or null when nothing was saved. */
export async function saveFile(path = store.get().activePath): Promise<string | null> {
    const f = path ? store.get().files.find((x) => fileKey(x.path) === fileKey(path)) : undefined
    if (!f) return null
    if (f.untitled === undefined && !f.missing) {
        await persistFile(f.path, true)
        return f.path
    }
    return serial(f.model, () => {
        const current = store.get().files.find((file) => file.model === operations.current(f.model))
        if (!current) return Promise.resolve(null)
        return current.untitled === undefined && !current.missing
            ? writeBuffer(current, true).then(() => current.path)
            : saveAs(current)
    })
}

function isBusy(f: FileState): boolean {
    const debug = store.get().debug
    return !!(
        f.runId ||
        f.terminalRunId ||
        f.terminalPending ||
        (debug.path === f.path && debug.state.status !== 'idle')
    )
}

/** Give an untitled tab its place on disk; its tests and settings move with it. */
async function saveAs(f: FileState): Promise<string | null> {
    if (f.model.isDisposed()) return null
    if (isBusy(f)) {
        toast('运行或调试中，请结束后再保存', 'info')
        return null
    }
    const picked = await api.fs.saveFileDialog(CPP.test(f.name) ? f.name : `${f.name}.cpp`)
    if (!picked) return null
    if (
        f.model.isDisposed() ||
        !store.get().files.some((file) => file.model === f.model) ||
        isBusy(store.get().files.find((file) => file.model === f.model)!)
    )
        return null
    const target = CPP.test(picked) ? picked : `${picked}.cpp`
    const key = fileKey(target)
    if (key === fileKey(f.path)) {
        if (f.untitled !== undefined) {
            toast('请选择新的保存位置，当前文件是应用管理的临时文件', 'info')
            return null
        }
        await writeBuffer(f, true)
        return f.path
    }
    if (
        opening.has(key) ||
        operations.targets.has(key) ||
        store.get().files.some((x) => x.model !== f.model && fileKey(x.path) === key)
    ) {
        toast(`${baseName(target)} 已在另一个标签页打开`, 'error')
        return null
    }
    operations.migrating.add(operations.owner(f.model))
    operations.targets.set(key, f.model)
    updateFile(f.path, { transitioning: true })
    try {
        const expected = (await api.fs.exists(target)) ? normalize(await api.fs.readText(target)) : null
        if (store.get().settings.editor.formatOnSave) await (await import('./format')).formatOnSaveHook(f.path, f.model)
        await flushProblemWrites(f.path)
        const code = f.model.getValue()
        await api.fs.writeText(target, code, { expected, confirmOverwrite: true })
        await api.problem.moveSource(f.path, target)
        if (f.untitled !== undefined) await api.fs.discardUntitled(f.path)
        swapIdentity(f, target, code)
        void api.problem.saved(target, code).catch(() => {})
    } catch (e) {
        toast(`保存失败：${(e as Error).message}`, 'error')
        return null
    } finally {
        operations.migrating.delete(operations.owner(f.model))
        if (operations.targets.get(key) === f.model) operations.targets.delete(key)
        const current = store.get().files.find((file) => file.model === operations.current(f.model))
        if (current) updateFile(current.path, { transitioning: false })
    }
    rememberRecent(target)
    await reloadProblem(target)
    return target
}

/** The same tab, now backed by `target`: a fresh model, with everything judge-related carried over. */
function swapIdentity(old: FileState, target: string, code: string): void {
    const wasActive = store.get().activePath === old.path
    const view =
        editorRef.editor && editorRef.editor.getModel() === old.model ? editorRef.editor.saveViewState() : old.viewState
    const fresh = { ...createFile(target, { saved: code, text: old.model.getValue() }), viewState: view }
    const oldPath = old.path
    editorRef.lang?.detach(old.model)
    store.set((st) => {
        const breakpoints = { ...st.breakpoints }
        if (breakpoints[oldPath]) {
            breakpoints[target] = breakpoints[oldPath]
            delete breakpoints[oldPath]
        }
        return {
            files: st.files.map((x) =>
                x.model === old.model
                    ? {
                          ...x,
                          path: target,
                          name: fresh.name,
                          untitled: undefined,
                          missing: false,
                          model: fresh.model,
                          savedVersion: fresh.savedVersion,
                          savedText: fresh.savedText,
                          dirty: fresh.dirty,
                          viewState: view
                      }
                    : x
            ),
            activePath: wasActive ? target : st.activePath,
            breakpoints
        }
    })
    editorRef.lang?.attach(fresh.model, target)
    operations.replace(old.model, fresh.model)
    if (wasActive) activate(target)
    old.model.dispose()
    forgetProblemWrites(oldPath)
}

export async function saveAll(): Promise<void> {
    for (const f of store.get().files.filter((f) => f.dirty || f.missing)) await saveFile(f.path)
}

const declined = new Map<FileState['model'], string>()

/**
 * Reconcile a file-backed tab with the disk (on window focus, and when a session is restored):
 * a missing file keeps its buffer and stays "unsaved"; changed content is reloaded when the tab is
 * clean and offered otherwise.
 */
export async function checkExternal(path: string): Promise<void> {
    const f = store.get().files.find((x) => x.path === path)
    if (!f || f.untitled !== undefined || operations.isSaving(f.model) || closing.has(operations.owner(f.model))) return
    if (!(await api.fs.exists(path))) {
        if (!f.missing) updateFile(path, { missing: true })
        return
    }
    let text: string
    try {
        text = normalize(await api.fs.readText(path))
    } catch {
        return
    }
    const current = store.get().files.find((x) => x.model === f.model)
    if (!current || operations.isSaving(current.model)) return
    if (!current.missing && text === current.savedText) return
    const model = current.model
    const live = model.getValue()
    const adopt = (): void => {
        const view = editorRef.editor && editorRef.editor.getModel() === model ? editorRef.editor.saveViewState() : null
        model.setValue(text)
        if (view) editorRef.editor?.restoreViewState(view)
        updateFile(current.path, {
            savedVersion: model.getAlternativeVersionId(),
            savedText: text,
            dirty: false,
            missing: false
        })
        declined.delete(model)
    }
    if (text === live) {
        updateFile(current.path, {
            savedVersion: model.getAlternativeVersionId(),
            savedText: text,
            dirty: false,
            missing: false
        })
        declined.delete(model)
        return
    }
    if (!current.dirty && !current.missing) return adopt()
    if (declined.get(model) === text) return
    if (confirm(`${current.name} 已在外部被修改。重新载入并放弃当前未保存的修改？`)) adopt()
    else declined.set(model, text)
}

export async function checkAllExternal(): Promise<void> {
    if (store.get().closing) return
    for (const f of store.get().files) await checkExternal(f.path)
}

export function closeFile(path: string): Promise<unknown> {
    const f = store.get().files.find((x) => fileKey(x.path) === fileKey(path))
    if (!f) return Promise.resolve()
    const owner = operations.owner(f.model)
    const pending = closing.get(owner)
    if (pending) return pending
    const job = doCloseFile(f)
        .catch((error: Error) => toast(`关闭失败，文件仍保留：${error.message}`, 'error', 6000))
        .finally(() => {
            if (closing.get(owner) === job) closing.delete(owner)
        })
    closing.set(owner, job)
    return job
}

/** Whether closing this tab would lose something the user has not saved. */
function needsAnswer(f: FileState): boolean {
    if (f.untitled !== undefined) return f.dirty
    return f.missing || (f.dirty && !store.get().settings.autoSave)
}

async function doCloseFile(original: FileState): Promise<unknown> {
    // A close must follow a pending Save As to the model/path which now owns the buffer.
    await operations.pendingSave(original.model)
    const currentModel = operations.current(original.model)
    if (currentModel !== original.model) {
        const current = store.get().files.find((file) => file.model === currentModel)
        if (!current) return
        original = current
    }
    original = store.get().files.find((file) => file.model === original.model) ?? original
    const path = original.path
    let discardVersion: number | undefined
    if (needsAnswer(original)) {
        const choice = await api.app.confirmUnsaved(original.name)
        if (choice === 'cancel') return
        if (choice === 'save') {
            const saved = await saveFile(path)
            if (!saved) return
            if (saved !== path) {
                const current = store.get().files.find((file) => file.path === saved)
                return current ? doCloseFile(current) : undefined
            }
        } else discardVersion = original.model.getAlternativeVersionId()
    }
    await (await import('./judge')).stopRun(path)
    await (await import('./terminal')).stopTerminal(path)
    if (store.get().debug.path === path) await (await import('./debug')).stopDebug()
    await flushProblemWrites(path)
    for (;;) {
        const current = store.get().files.find((f) => f.path === path && f.model === original.model)
        if (!current) return
        if (!current.dirty || discardVersion === current.model.getAlternativeVersionId()) break
        if (current.untitled === undefined && store.get().settings.autoSave) {
            await persistFile(path)
            continue
        }
        // edits arrived while the tab was shutting down
        const choice = await api.app.confirmUnsaved(current.name)
        if (choice === 'cancel') return
        if (choice === 'save') {
            const saved = await saveFile(path)
            if (!saved) return
            if (saved !== path) {
                const current = store.get().files.find((file) => file.path === saved)
                return current ? doCloseFile(current) : undefined
            }
            continue
        }
        discardVersion = current.model.getAlternativeVersionId()
    }
    // Also capture edits made while code was saving, before removing this model.
    await flushProblemWrites(path)
    const before = store.get()
    const target = before.files.find((f) => f.path === path && f.model === original.model)
    if (!target) return
    if (
        target.dirty &&
        discardVersion !== target.model.getAlternativeVersionId() &&
        (target.untitled !== undefined || store.get().settings.autoSave)
    )
        return doCloseFile(target)
    const idx = before.files.indexOf(target)
    const wasActive = before.activePath === path
    editorRef.lang?.detach(original.model)
    store.set((current) => {
        const files = current.files.filter((f) => f.model !== original.model)
        return {
            files,
            activePath:
                current.activePath === path ? ((files[idx] ?? files[idx - 1])?.path ?? null) : current.activePath
        }
    })
    if (wasActive) {
        const next = store.get().activePath
        if (next) activate(next)
        else editorRef.editor?.setModel(null)
    }
    original.model.dispose()
    declined.delete(original.model)
    forgetProblemWrites(path)
    // An unsaved new file that was let go leaves nothing behind.
    if (original.untitled !== undefined) await api.fs.discardUntitled(path).catch(() => {})
}

function rememberRecent(path: string): void {
    const recent = [path, ...store.get().settings.recentFiles.filter((p) => p !== path)].slice(0, 20)
    store.set((s) => ({ settings: { ...s.settings, recentFiles: recent } }))
    void api.settings.set({ recentFiles: recent }).catch((error: Error) => toast(error.message, 'error'))
}
