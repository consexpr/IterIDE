import { beforeEach, describe, expect, it, vi } from 'vitest'

const f = vi.hoisted(() => {
    class FakeModel {
        version = 1
        alt = 1
        disposed = false
        listeners: (() => void)[] = []
        constructor(public text: string) {}
        getValue() {
            return this.text
        }
        getValueLength() {
            return this.text.length
        }
        setValue(text: string) {
            this.text = text
            this.alt = ++this.version
            this.listeners.forEach((cb) => cb())
        }
        getAlternativeVersionId() {
            return this.alt
        }
        isDisposed() {
            return this.disposed
        }
        dispose() {
            this.disposed = true
        }
        setEOL() {}
        onDidChangeContent(cb: () => void) {
            this.listeners.push(cb)
        }
    }
    const models = new Map<string, FakeModel>()
    let state: any
    const initial = () => ({
        files: [] as any[],
        activePath: null as string | null,
        closing: false,
        breakpoints: {} as Record<string, unknown>,
        debug: { state: { status: 'idle' }, path: null },
        settings: {
            template: 'int main() {$0}',
            autoSave: true,
            editor: { formatOnSave: false },
            recentFiles: [] as string[]
        }
    })
    state = initial()
    const lang = { attach: vi.fn(), detach: vi.fn() }
    const editor = {
        getModel: vi.fn(() => null),
        saveViewState: vi.fn(() => null),
        restoreViewState: vi.fn(),
        setModel: vi.fn(),
        focus: vi.fn(),
        setPosition: vi.fn(),
        revealPositionInCenter: vi.fn()
    }
    const disk = new Map<string, string>()
    const api = {
        app: {
            platform: 'linux',
            confirmUnsaved: vi.fn(async (_name: string): Promise<'save' | 'discard' | 'cancel'> => 'cancel')
        },
        fs: {
            readText: vi.fn(async (p: string) => {
                if (!disk.has(p)) throw new Error('ENOENT')
                return disk.get(p)!
            }),
            writeText: vi.fn(async (p: string, t: string) => {
                disk.set(p, t)
            }),
            exists: vi.fn(async (p: string) => disk.has(p)),
            createUntitled: vi.fn(async (n: number, text: string) => {
                const p = `/store/untitled/Untitled-${n}.cpp`
                disk.set(p, text)
                return p
            }),
            discardUntitled: vi.fn(async (p: string) => {
                disk.delete(p)
            }),
            saveFileDialog: vi.fn(async (_name: string): Promise<string | null> => null),
            openFileDialog: vi.fn(async () => [])
        },
        lsp: { refreshCompileFlags: vi.fn(async () => {}) },
        problem: {
            load: vi.fn(async () => ({ version: 1 })),
            readTests: vi.fn(async () => []),
            moveSource: vi.fn(async () => {}),
            saved: vi.fn(async () => {})
        },
        settings: { set: vi.fn(async () => ({})) }
    }
    return {
        FakeModel,
        models,
        disk,
        api,
        lang,
        editor,
        toast: vi.fn(),
        reset: () => {
            state = initial()
            models.clear()
            disk.clear()
        },
        get state() {
            return state
        },
        set state(v) {
            state = v
        }
    }
})

vi.mock('../state/app', () => ({
    store: {
        get: () => f.state,
        set: (patch: any) => {
            f.state = { ...f.state, ...(typeof patch === 'function' ? patch(f.state) : patch) }
        }
    },
    activeFile: (s = f.state) => s.files.find((x: any) => x.path === s.activePath) ?? null,
    updateFile: (path: string, patch: any) => {
        f.state = { ...f.state, files: f.state.files.map((x: any) => (x.path === path ? { ...x, ...patch } : x)) }
    },
    toast: f.toast
}))
vi.mock('../editor/instance', () => ({ editorRef: { editor: f.editor, lang: f.lang } }))
vi.mock('../editor/indentation', () => ({ applyModelIndentation: () => {} }))
vi.mock('../editor/monaco', () => ({
    monaco: {
        Uri: { file: (path: string) => ({ path }) },
        editor: {
            EndOfLineSequence: { LF: 0 },
            getModel: (uri: any) => f.models.get(uri.path) ?? null,
            createModel: (text: string, _lang: string, uri: any) => {
                const m = new f.FakeModel(text)
                f.models.set(uri.path, m)
                m.dispose = () => {
                    m.disposed = true
                    f.models.delete(uri.path)
                }
                return m
            }
        }
    }
}))
vi.mock('./problemWrites', () => ({
    flushProblemWrites: vi.fn(async () => {}),
    forgetProblemWrites: vi.fn(),
    overlayProblemWrites: (_path: string, problem: unknown, tests: unknown[]) => ({ problem, tests })
}))
vi.mock('./judge', () => ({ stopRun: vi.fn(async () => {}) }))
vi.mock('./terminal', () => ({ stopTerminal: vi.fn(async () => {}) }))
vi.mock('./debug', () => ({ stopDebug: vi.fn(async () => {}) }))

const A = '/work/a.cpp'
const file = (path = A): any => f.state.files.find((x: any) => x.path === path)
async function files() {
    return import('./files')
}

beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    f.reset()
    vi.stubGlobal('window', { iter: f.api })
    vi.stubGlobal(
        'confirm',
        vi.fn(() => true)
    )
    f.api.app.confirmUnsaved.mockResolvedValue('cancel')
    f.api.fs.saveFileDialog.mockResolvedValue(null)
})

describe('tab order', () => {
    it('moves tabs in both directions while preserving the active buffer and saved session order', async () => {
        const { newUntitled, moveFile } = await files()
        await newUntitled()
        await newUntitled()
        await newUntitled()
        const [first, second, third] = f.state.files
        second.model.setValue('unsaved code')
        const edited = file(second.path)
        const active = f.state.activePath
        f.editor.setModel.mockClear()

        moveFile(first.path, null)
        expect(f.state.files).toEqual([edited, third, first])
        moveFile(third.path, second.path)
        expect(f.state.files).toEqual([third, edited, first])
        expect(f.state.files[1]).toBe(edited)
        expect(edited.model.getValue()).toBe('unsaved code')
        expect(edited.dirty).toBe(true)
        expect(f.state.activePath).toBe(active)
        expect(f.editor.setModel).not.toHaveBeenCalled()
        const { sessionSnapshot } = await import('./session')
        expect(sessionSnapshot().tabs.map((tab) => tab.path)).toEqual([third.path, second.path, first.path])
    })

    it('ignores no-op drops and tabs closed or renamed during a drag', async () => {
        const { newUntitled, moveFile } = await files()
        await newUntitled()
        await newUntitled()
        const original = f.state.files
        const [first, second] = original
        moveFile(first.path, first.path)
        moveFile(first.path, second.path)
        moveFile(second.path, null)
        moveFile('/closed.cpp', first.path)
        moveFile(first.path, '/closed.cpp')
        expect(f.state.files).toBe(original)
        f.state = { ...f.state, closing: true }
        moveFile(second.path, first.path)
        expect(f.state.files).toBe(original)
    })
})

describe('untitled tabs', () => {
    it('waits for an accepted new tab before taking the final session snapshot', async () => {
        const { newUntitled, flushFileOperations } = await files()
        let finishCreate!: (path: string) => void
        f.api.fs.createUntitled.mockImplementationOnce(
            () =>
                new Promise<string>((resolve) => {
                    finishCreate = resolve
                })
        )
        const creating = newUntitled()
        f.state = { ...f.state, closing: true }
        let flushed = false
        const flushing = flushFileOperations().then(() => {
            flushed = true
        })
        await Promise.resolve()
        expect(flushed).toBe(false)
        finishCreate('/store/untitled/Untitled-1.cpp')
        await Promise.all([creating, flushing])
        expect(f.state.files).toHaveLength(1)
        expect(f.state.files[0].path).toBe('/store/untitled/Untitled-1.cpp')
    })

    it('does not move another tab cursor when loading the new problem finishes late', async () => {
        const { newUntitled } = await files()
        let finishLoad!: (problem: { version: number }) => void
        f.api.problem.load.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finishLoad = resolve
                })
        )
        const creating = newUntitled()
        await vi.waitFor(() => expect(finishLoad).toBeTypeOf('function'))
        const otherModel = { getPositionAt: vi.fn(() => ({ lineNumber: 1, column: 1 })) }
        f.editor.getModel.mockReturnValueOnce(otherModel as any)
        finishLoad({ version: 1 })
        await creating
        expect(otherModel.getPositionAt).not.toHaveBeenCalled()
        expect(f.editor.setPosition).not.toHaveBeenCalled()
    })

    it.each(['same path', 'normalized alias'])('refuses Save As onto its own managed file: %s', async (variant) => {
        const { newUntitled, saveFile } = await files()
        await newUntitled()
        const original = f.state.files[0]
        original.model.setValue('unsaved buffer')
        const target = variant === 'same path' ? original.path : original.path.replace('/untitled/', '/untitled/./')
        f.api.fs.saveFileDialog.mockResolvedValue(target)
        expect(await saveFile(original.path)).toBeNull()
        expect(f.api.fs.writeText).not.toHaveBeenCalled()
        expect(f.api.problem.moveSource).not.toHaveBeenCalled()
        expect(f.api.fs.discardUntitled).not.toHaveBeenCalled()
        expect(f.state.files).toHaveLength(1)
        expect(f.state.files[0].model).toBe(original.model)
        expect(original.model.isDisposed()).toBe(false)
        expect(original.model.getValue()).toBe('unsaved buffer')
    })

    it('keeps one save queue across migration for jobs accepted before and after Save As', async () => {
        const { newUntitled, saveFile, persistFile } = await files()
        await newUntitled()
        const original = f.state.files[0]
        f.api.fs.saveFileDialog.mockResolvedValue('/work/ordered.cpp')
        let finishFirst!: () => void, finishQueued!: () => void
        f.api.fs.writeText
            .mockImplementationOnce(async (path, text) => {
                await new Promise<void>((resolve) => {
                    finishFirst = resolve
                })
                f.disk.set(path, text)
            })
            .mockImplementationOnce(async (path, text) => {
                await new Promise<void>((resolve) => {
                    finishQueued = resolve
                })
                f.disk.set(path, text)
            })
        const migrating = saveFile(original.path)
        await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'))
        original.model.setValue('older queued snapshot')
        const queuedBeforeMigration = persistFile(original.path)
        finishFirst()
        await migrating
        await vi.waitFor(() => expect(finishQueued).toBeTypeOf('function'))
        file('/work/ordered.cpp').model.setValue('latest snapshot')
        const queuedAfterMigration = persistFile('/work/ordered.cpp')
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(f.api.fs.writeText).toHaveBeenCalledTimes(2)
        finishQueued()
        await Promise.all([queuedBeforeMigration, queuedAfterMigration])
        expect(f.disk.get('/work/ordered.cpp')).toBe('latest snapshot')
        expect(file('/work/ordered.cpp').dirty).toBe(false)
    })
    it('preserves edits accepted while Save As writes and leaves them dirty', async () => {
        const { newUntitled, saveFile } = await files()
        await newUntitled()
        const original = f.state.files[0]
        original.model.setValue('saved snapshot')
        f.api.fs.saveFileDialog.mockResolvedValue('/work/saved.cpp')
        let complete!: () => void
        f.api.fs.writeText.mockImplementationOnce(async (path, text) => {
            await new Promise<void>((resolve) => {
                complete = resolve
            })
            f.disk.set(path, text)
        })
        const saving = saveFile(original.path)
        await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
        original.model.setValue('newer unsaved edit')
        complete()
        await saving
        expect(f.disk.get('/work/saved.cpp')).toBe('saved snapshot')
        expect(file('/work/saved.cpp')).toMatchObject({ savedText: 'saved snapshot', dirty: true })
        expect(file('/work/saved.cpp').model.getValue()).toBe('newer unsaved edit')
    })

    it('follows Save As when a close arrives during its write and saves intervening edits', async () => {
        const { newUntitled, saveFile, closeFile } = await files()
        await newUntitled()
        const original = f.state.files[0]
        f.api.fs.saveFileDialog.mockResolvedValue('/work/closed.cpp')
        let complete!: () => void
        f.api.fs.writeText.mockImplementationOnce(async (path, text) => {
            await new Promise<void>((resolve) => {
                complete = resolve
            })
            f.disk.set(path, text)
        })
        const saving = saveFile(original.path)
        await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
        const closing = closeFile(original.path)
        original.model.setValue('must survive close')
        complete()
        await Promise.all([saving, closing])
        expect(f.disk.get('/work/closed.cpp')).toBe('must survive close')
        expect(f.state.files).toEqual([])
        expect(f.api.app.confirmUnsaved).not.toHaveBeenCalled()
    })

    it('queues opening the target behind identity migration instead of creating another model', async () => {
        const { newUntitled, saveFile, openFile } = await files()
        await newUntitled()
        const original = f.state.files[0]
        f.api.fs.saveFileDialog.mockResolvedValue('/work/target.cpp')
        let complete!: () => void
        f.api.fs.writeText.mockImplementationOnce(async (path, text) => {
            await new Promise<void>((resolve) => {
                complete = resolve
            })
            f.disk.set(path, text)
        })
        const saving = saveFile(original.path)
        await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
        const opening = openFile('/work/target.cpp')
        complete()
        await Promise.all([saving, opening])
        expect(f.state.files).toHaveLength(1)
        expect(f.state.files[0].path).toBe('/work/target.cpp')
    })
    it('start clean on the template, take the lowest free number, and turn unsaved on edit', async () => {
        const { newUntitled } = await files()
        await Promise.all([newUntitled(), newUntitled()])
        expect(f.state.files.map((x: any) => x.name).sort()).toEqual(['Untitled-1', 'Untitled-2'])
        const first = f.state.files.find((x: any) => x.untitled === 1)
        expect(first).toMatchObject({
            dirty: false,
            savedText: 'int main() {}',
            path: '/store/untitled/Untitled-1.cpp'
        })
        first.model.setValue('int main() { return 0; }')
        expect(file(first.path).dirty).toBe(true)
        first.model.setValue('int main() {}')
        expect(file(first.path).dirty).toBe(false)
    })

    it('a written-out buffer keeps the tab unsaved', async () => {
        const { newUntitled, persistFile } = await files()
        await newUntitled()
        const tab = f.state.files[0]
        tab.model.setValue('changed')
        await persistFile(tab.path)
        expect(f.disk.get(tab.path)).toBe('changed')
        expect(file(tab.path).dirty).toBe(true)
    })

    it('saving asks for a place, moves the tests with the file, and re-keys the tab', async () => {
        const { newUntitled, saveFile } = await files()
        await newUntitled()
        const old = f.state.files[0]
        old.model.setValue('my code')
        f.state.breakpoints = { [old.path]: [{ line: 3 }] }
        f.state.activePath = old.path
        f.api.fs.saveFileDialog.mockResolvedValue('/work/sol')
        expect(await saveFile(old.path)).toBe('/work/sol.cpp')
        expect(f.api.fs.writeText).toHaveBeenCalledWith('/work/sol.cpp', 'my code', {
            expected: null,
            confirmOverwrite: true
        })
        expect(f.api.problem.moveSource).toHaveBeenCalledWith(old.path, '/work/sol.cpp')
        expect(f.api.fs.discardUntitled).toHaveBeenCalledWith(old.path)
        expect(f.state.files).toHaveLength(1)
        expect(file('/work/sol.cpp')).toMatchObject({
            name: 'sol.cpp',
            dirty: false,
            savedText: 'my code',
            missing: false
        })
        expect(file('/work/sol.cpp').untitled).toBeUndefined()
        expect(f.state.activePath).toBe('/work/sol.cpp')
        expect(f.state.breakpoints).toEqual({ '/work/sol.cpp': [{ line: 3 }] })
        expect(old.model.isDisposed()).toBe(true)
        expect(f.state.settings.recentFiles).toEqual(['/work/sol.cpp'])
    })

    it('a cancelled save dialog changes nothing', async () => {
        const { newUntitled, saveFile } = await files()
        await newUntitled()
        const tab = f.state.files[0]
        expect(await saveFile(tab.path)).toBeNull()
        expect(f.api.problem.moveSource).not.toHaveBeenCalled()
        expect(file(tab.path)).toBeTruthy()
    })

    it('refuses a destination that is open in another tab', async () => {
        const { newUntitled, openFile, saveFile } = await files()
        f.disk.set(A, 'x')
        await openFile(A)
        await newUntitled()
        const tab = f.state.files.find((x: any) => x.untitled === 1)
        f.api.fs.saveFileDialog.mockResolvedValue(A)
        expect(await saveFile(tab.path)).toBeNull()
        expect(f.api.fs.writeText).not.toHaveBeenCalledWith(A, expect.anything())
        expect(f.toast).toHaveBeenCalled()
    })
})

describe('closing tabs', () => {
    it('an untouched new file goes away silently, with its data', async () => {
        const { newUntitled, closeFile } = await files()
        await newUntitled()
        const path = f.state.files[0].path
        await closeFile(path)
        expect(f.api.app.confirmUnsaved).not.toHaveBeenCalled()
        expect(f.state.files).toEqual([])
        expect(f.api.fs.discardUntitled).toHaveBeenCalledWith(path)
    })

    it('an edited new file asks, and Cancel keeps it', async () => {
        const { newUntitled, closeFile } = await files()
        await newUntitled()
        const tab = f.state.files[0]
        tab.model.setValue('work')
        await closeFile(tab.path)
        expect(f.api.app.confirmUnsaved).toHaveBeenCalledWith('Untitled-1')
        expect(f.state.files).toHaveLength(1)
        expect(f.api.fs.discardUntitled).not.toHaveBeenCalled()
    })

    it('Discard drops the new file; Save puts it on disk first and then closes it', async () => {
        const { newUntitled, closeFile } = await files()
        await newUntitled()
        f.state.files[0].model.setValue('one')
        f.api.app.confirmUnsaved.mockResolvedValueOnce('discard')
        await closeFile(f.state.files[0].path)
        expect(f.state.files).toEqual([])

        await newUntitled()
        f.state.files[0].model.setValue('two')
        f.api.app.confirmUnsaved.mockResolvedValueOnce('save')
        f.api.fs.saveFileDialog.mockResolvedValue('/work/two.cpp')
        await closeFile(f.state.files[0].path)
        expect(f.disk.get('/work/two.cpp')).toBe('two')
        expect(f.state.files).toEqual([])
        expect(f.api.app.confirmUnsaved).toHaveBeenCalledTimes(2)
    })

    it('Save with a cancelled dialog keeps the tab open', async () => {
        const { newUntitled, closeFile } = await files()
        await newUntitled()
        f.state.files[0].model.setValue('x')
        f.api.app.confirmUnsaved.mockResolvedValueOnce('save')
        await closeFile(f.state.files[0].path)
        expect(f.state.files).toHaveLength(1)
    })

    it('a saved file closes silently; an edited one is written first when auto-save is on', async () => {
        const { openFile, closeFile } = await files()
        f.disk.set(A, 'orig')
        await openFile(A)
        file().model.setValue('edited')
        await closeFile(A)
        expect(f.api.app.confirmUnsaved).not.toHaveBeenCalled()
        expect(f.disk.get(A)).toBe('edited')
        expect(f.state.files).toEqual([])
    })

    it('with auto-save off an edited file asks, and a deleted file asks even with auto-save on', async () => {
        const { openFile, closeFile, checkExternal } = await files()
        f.disk.set(A, 'orig')
        await openFile(A)
        f.state.settings.autoSave = false
        file().model.setValue('edited')
        await closeFile(A)
        expect(f.api.app.confirmUnsaved).toHaveBeenCalledTimes(1)
        expect(f.state.files).toHaveLength(1)

        f.state.settings.autoSave = true
        f.disk.delete(A)
        await checkExternal(A)
        f.api.app.confirmUnsaved.mockResolvedValueOnce('discard')
        await closeFile(A)
        expect(f.api.app.confirmUnsaved).toHaveBeenCalledTimes(2)
        expect(f.state.files).toEqual([])
        expect(f.disk.has(A)).toBe(false)
    })
})

describe('external changes', () => {
    it('a deleted file stays unsaved, avoids automatic writes, and saves to a chosen location', async () => {
        const { openFile, checkExternal, saveFile } = await files()
        f.disk.set(A, 'orig')
        await openFile(A)
        f.disk.delete(A)
        await checkExternal(A)
        expect(file()).toMatchObject({ missing: true })
        expect(file().model.getValue()).toBe('orig')
        const { persistFile } = await files()
        await persistFile(A)
        expect(f.disk.has(A)).toBe(false)
        f.api.fs.saveFileDialog.mockResolvedValue('/work/recovered.cpp')
        await saveFile(A)
        expect(f.disk.has(A)).toBe(false)
        expect(f.disk.get('/work/recovered.cpp')).toBe('orig')
        expect(file('/work/recovered.cpp').missing).toBe(false)
        expect(f.api.fs.discardUntitled).not.toHaveBeenCalled()
    })

    it('a file that comes back clears the missing mark', async () => {
        const { openFile, checkExternal } = await files()
        f.disk.set(A, 'orig')
        await openFile(A)
        f.disk.delete(A)
        await checkExternal(A)
        f.disk.set(A, 'orig')
        await checkExternal(A)
        expect(file().missing).toBe(false)
    })

    it('reloads a clean tab, adopts equal content, and leaves unchanged files alone', async () => {
        const { openFile, checkExternal } = await files()
        f.disk.set(A, 'orig')
        await openFile(A)
        await checkExternal(A)
        expect(file().model.getValue()).toBe('orig')
        f.disk.set(A, 'changed outside')
        await checkExternal(A)
        expect(file()).toMatchObject({ dirty: false, savedText: 'changed outside' })
        expect(file().model.getValue()).toBe('changed outside')
        expect(confirm).not.toHaveBeenCalled()
        file().model.setValue('typed')
        f.disk.set(A, 'typed')
        await checkExternal(A)
        expect(file()).toMatchObject({ dirty: false, savedText: 'typed' })
    })

    it('asks before replacing unsaved edits, and only once per outside version when declined', async () => {
        const { openFile, checkExternal } = await files()
        f.disk.set(A, 'orig')
        await openFile(A)
        file().model.setValue('mine')
        f.disk.set(A, 'theirs')
        vi.mocked(confirm).mockReturnValueOnce(false)
        await checkExternal(A)
        await checkExternal(A)
        expect(confirm).toHaveBeenCalledTimes(1)
        expect(file().model.getValue()).toBe('mine')
        expect(file().dirty).toBe(true)
        f.disk.set(A, 'theirs again')
        vi.mocked(confirm).mockReturnValueOnce(true)
        await checkExternal(A)
        expect(file().model.getValue()).toBe('theirs again')
        expect(file().dirty).toBe(false)
    })

    it('never touches an untitled tab', async () => {
        const { newUntitled, checkExternal } = await files()
        await newUntitled()
        const path = f.state.files[0].path
        f.disk.delete(path)
        await checkExternal(path)
        expect(file(path).missing).toBe(false)
    })
})

describe('session restore', () => {
    it('guards normal saves with their disk baseline and reserves overwrite prompts for explicit saves', async () => {
        const { openFile, persistFile, saveFile } = await files()
        f.disk.set(A, 'original')
        await openFile(A)
        file().model.setValue('first edit')
        await persistFile(A)
        expect(f.api.fs.writeText).toHaveBeenLastCalledWith(A, 'first edit', {
            expected: 'original',
            confirmOverwrite: false
        })
        file().model.setValue('second edit')
        f.api.fs.writeText.mockRejectedValueOnce(new Error('external conflict'))
        await expect(saveFile(A)).rejects.toThrow('external conflict')
        expect(f.api.fs.writeText).toHaveBeenLastCalledWith(A, 'second edit', {
            expected: 'first edit',
            confirmOverwrite: true
        })
        expect(file()).toMatchObject({ dirty: true, savedText: 'first edit' })
        expect(file().model.getValue()).toBe('second edit')
        expect(f.disk.get(A)).toBe('first edit')
    })
    it('does not replace an already open buffer with an older session or duplicate its model', async () => {
        const { openFile, restoreTab } = await files()
        f.disk.set(A, 'disk')
        await openFile(A)
        const original = file()
        original.model.setValue('current edits')
        await restoreTab({ path: A, text: 'older session', saved: 'disk' })
        expect(f.state.files).toHaveLength(1)
        expect(file().model).toBe(original.model)
        expect(file().model.getValue()).toBe('current edits')
    })

    it('deduplicates a normal open while restoration is waiting for the filesystem', async () => {
        const { openFile, restoreTab } = await files()
        f.disk.set(A, 'disk')
        let exists!: (value: boolean) => void
        f.api.fs.exists.mockImplementationOnce(
            () =>
                new Promise<boolean>((resolve) => {
                    exists = resolve
                })
        )
        const restoring = restoreTab({ path: A, text: 'disk', saved: 'disk' })
        const opening = openFile(A)
        exists(true)
        await Promise.all([restoring, opening])
        expect(f.state.files).toHaveLength(1)
        expect(f.state.files[0].model.isDisposed()).toBe(false)
    })
    it('brings back an edited file as unsaved, even when it is gone', async () => {
        const { restoreTab } = await files()
        f.disk.set(A, 'orig')
        await restoreTab({ path: A, text: 'edited', saved: 'orig' })
        expect(file()).toMatchObject({ dirty: true, missing: false, savedText: 'orig' })
        expect(file().model.getValue()).toBe('edited')
        await restoreTab({ path: '/work/gone.cpp', text: 'lost?', saved: 'lost?' })
        expect(file('/work/gone.cpp')).toMatchObject({ missing: true, dirty: false })
        expect(file('/work/gone.cpp').model.getValue()).toBe('lost?')
    })

    it('applies an outside change that happened while the app was closed', async () => {
        const { restoreTab } = await files()
        f.disk.set(A, 'new on disk')
        await restoreTab({ path: A, text: 'orig', saved: 'orig' })
        expect(file().model.getValue()).toBe('new on disk')
        expect(file().dirty).toBe(false)
    })

    it('an untitled tab returns unsaved with its buffer and a managed file to run from', async () => {
        const { restoreTab } = await files()
        const path = '/store/untitled/Untitled-4.cpp'
        await restoreTab({ path, untitled: 4, text: 'draft', saved: 'int main() {}' })
        expect(file(path)).toMatchObject({ name: 'Untitled-4', untitled: 4, dirty: true })
        expect(f.disk.get(path)).toBe('draft')
    })
})

it('regression: a recovered clean missing tab keeps its buffer when a different file reappears', async () => {
    const { restoreTab, checkExternal } = await files()
    await restoreTab({ path: A, text: 'recovered content', saved: 'recovered content' })
    expect(file(A)).toMatchObject({ missing: true, dirty: false })
    f.disk.set(A, 'different new file')
    vi.mocked(confirm).mockReturnValue(false)
    await checkExternal(A)
    expect(file(A).model.getValue()).toBe('recovered content')
    expect(file(A).missing).toBe(true)
    expect(confirm).toHaveBeenCalledOnce()
    await checkExternal(A)
    expect(confirm).toHaveBeenCalledOnce()
})
it('regression: saving a recovered file to its own former path preserves its model', async () => {
    const { restoreTab, saveFile } = await files()
    await restoreTab({ path: A, text: 'recovered content', saved: 'recovered content' })
    f.api.fs.saveFileDialog.mockResolvedValue(A)
    const model = file(A).model
    expect(await saveFile(A)).toBe(A)
    expect(f.disk.get(A)).toBe('recovered content')
    expect(file(A).missing).toBe(false)
    expect(file(A).model).toBe(model)
    expect(model.isDisposed()).toBe(false)
})

it('keeps a declined recovery conflict across another session restore', async () => {
    f.disk.set(A, 'replacement')
    vi.mocked(confirm).mockReturnValue(false)
    const { restoreTab } = await files()
    await restoreTab({ path: A, text: 'recovered', saved: 'recovered', missing: true })
    expect(file(A)).toMatchObject({ missing: true, dirty: false })
    expect(file(A).model.getValue()).toBe('recovered')
    expect(confirm).toHaveBeenCalledOnce()
})
