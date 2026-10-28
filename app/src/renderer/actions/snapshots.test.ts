import { beforeEach, expect, it, vi } from 'vitest'

const f = vi.hoisted(() => {
    const state: any = { files: [], activePath: null, closing: false }
    return { state, toast: vi.fn(), api: { create: vi.fn(), read: vi.fn(), rename: vi.fn(), delete: vi.fn() } }
})
vi.mock('../state/app', () => ({
    store: { get: () => f.state },
    activeFile: () => f.state.files.find((file: any) => file.path === f.state.activePath),
    isDebugging: () => !!f.state.debugging,
    toast: f.toast
}))
vi.mock('./files', () => ({
    isFileTransitioning: () => false,
    withFileOperation: (_file: unknown, task: (file: unknown) => Promise<unknown>) => task(_file)
}))
vi.stubGlobal('window', { iter: { snapshots: f.api } })
import { restoreSnapshot, saveSnapshot, snapshotState } from './snapshots'

function file(path: string, initial = 'current') {
    let code = initial,
        version = 1
    return {
        path,
        name: path,
        model: {
            getValue: () => code,
            getVersionId: () => version,
            isDisposed: () => false,
            getFullModelRange: () => ({}),
            pushStackElement: vi.fn(),
            pushEditOperations: vi.fn((_selections, edits) => {
                code = edits[0].text
                version++
            }),
            edit: (text: string) => {
                code = text
                version++
            }
        }
    }
}
function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => {
        resolve = done
    })
    return { promise, resolve }
}
beforeEach(() => {
    vi.clearAllMocks()
    f.api.create.mockReset().mockResolvedValue({ id: 'backup' })
    f.api.read.mockReset().mockResolvedValue({ id: 'snapshot', code: 'old' })
    f.state.files = [file('/a.cpp'), file('/b.cpp', 'other')]
    f.state.activePath = '/a.cpp'
    f.state.closing = false
    f.state.debugging = false
    snapshotState.set({ revision: 0, busy: new Set() })
})

it('saves the active unsaved buffer and keeps the captured file when tabs switch', async () => {
    const saving = deferred<unknown>()
    f.api.create.mockReturnValueOnce(saving.promise)
    const job = saveSnapshot()
    f.state.activePath = '/b.cpp'
    f.state.files[0].model.edit('typed later')
    saving.resolve({ id: 'new' })
    await job
    expect(f.api.create).toHaveBeenCalledWith('/a.cpp', 'current')
})

it('backs up before restoring and makes the replacement one undoable edit', async () => {
    const model = f.state.files[0].model
    await restoreSnapshot('/a.cpp', 'snapshot')
    expect(f.api.create).toHaveBeenCalledWith('/a.cpp', 'current', '恢复前自动保存')
    expect(model.getValue()).toBe('old')
    expect(model.pushEditOperations).toHaveBeenCalledTimes(1)
    expect(model.pushStackElement).toHaveBeenCalledTimes(2)
    expect(f.state.files[1].model.getValue()).toBe('other')
})

it('keeps code intact when the recovery copy cannot be saved', async () => {
    f.api.create.mockRejectedValueOnce(new Error('disk full'))
    await restoreSnapshot('/a.cpp', 'snapshot')
    expect(f.state.files[0].model.getValue()).toBe('current')
    expect(f.toast).toHaveBeenCalledWith(expect.stringContaining('disk full'), 'error')
})

it('cancels restoration if the user edits while its backup is being written', async () => {
    const saving = deferred<unknown>()
    f.api.create.mockImplementationOnce(() => {
        f.state.files[0].model.edit('new typing')
        return saving.promise
    })
    const job = restoreSnapshot('/a.cpp', 'snapshot')
    saving.resolve({ id: 'backup' })
    await job
    expect(f.state.files[0].model.getValue()).toBe('new typing')
})

it('does not restore into either program when the active tab changes during reading', async () => {
    const reading = deferred<unknown>()
    f.api.read.mockReturnValueOnce(reading.promise)
    const job = restoreSnapshot('/a.cpp', 'snapshot')
    f.state.activePath = '/b.cpp'
    reading.resolve({ id: 'snapshot', code: 'old' })
    await job
    expect(f.api.create).not.toHaveBeenCalled()
    expect(f.state.files.map((item: any) => item.model.getValue())).toEqual(['current', 'other'])
})

it('ignores overlapping saves for the same file', async () => {
    const saving = deferred<unknown>()
    f.api.create.mockReturnValueOnce(saving.promise)
    const first = saveSnapshot()
    await saveSnapshot()
    saving.resolve({ id: 'new' })
    await first
    expect(f.api.create).toHaveBeenCalledTimes(1)
    expect(snapshotState.get().busy.size).toBe(0)
})

it('does not replace the debug session source', async () => {
    f.state.debugging = true
    await restoreSnapshot('/a.cpp', 'snapshot')
    expect(f.api.read).not.toHaveBeenCalled()
    expect(f.state.files[0].model.getValue()).toBe('current')
})
