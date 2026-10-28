import { activeFile, isDebugging, store, toast, type FileState } from '../state/app'
import { Store } from '../state/store'
import { isFileTransitioning, withFileOperation } from './files'

/** The page and shortcut share operation state; histories themselves are loaded on demand. */
export const snapshotState = new Store({ revision: 0, busy: new Set<string>() })

function canStart(file: FileState): boolean {
    return !store.get().closing && !isFileTransitioning(file.path) && !snapshotState.get().busy.has(file.path)
}

async function operation<T>(file: FileState, task: (current: FileState) => Promise<T>): Promise<T | undefined> {
    if (!canStart(file)) return
    snapshotState.set((s) => ({ busy: new Set(s.busy).add(file.path) }))
    try {
        return await withFileOperation(file, task)
    } catch (error) {
        toast(`快照操作失败：${(error as Error).message}`, 'error')
        return undefined
    } finally {
        snapshotState.set((s) => {
            const busy = new Set(s.busy)
            busy.delete(file.path)
            return { busy, revision: s.revision + 1 }
        })
    }
}

export async function saveSnapshot(): Promise<void> {
    const file = activeFile()
    if (!file) return
    // Capture at the keypress, even if another save is still queued.
    const code = file.model.getValue()
    await operation(file, async (current) => {
        await window.iter.snapshots.create(current.path, code)
        toast(`已保存 ${current.name} 的快照`, 'success')
    })
}

export async function restoreSnapshot(path: string, id: string): Promise<void> {
    const file = activeFile()
    if (!file || file.path !== path) return
    if (isDebugging()) {
        toast('请结束调试后再恢复代码')
        return
    }
    await operation(file, async (current) => {
        const stillCurrent = (): boolean =>
            activeFile()?.model === current.model &&
            !current.model.isDisposed() &&
            !store.get().closing &&
            !isFileTransitioning(current.path) &&
            !isDebugging()
        const snapshot = await window.iter.snapshots.read(current.path, id)
        if (!stillCurrent()) return
        const model = current.model
        const before = model.getValue()
        if (before === snapshot.code) {
            toast('当前代码与快照相同')
            return
        }
        const version = model.getVersionId()
        // A failed backup must never overwrite the editor. Disk source is untouched here.
        await window.iter.snapshots.create(current.path, before, '恢复前自动保存')
        if (!stillCurrent() || model.getVersionId() !== version) {
            toast('代码或当前文件已变化，已取消恢复')
            return
        }
        model.pushStackElement()
        model.pushEditOperations([], [{ range: model.getFullModelRange(), text: snapshot.code }], () => null)
        model.pushStackElement()
        toast('已恢复到编辑器，恢复前的代码已保存为快照', 'success')
    })
}

export async function renameSnapshot(path: string, id: string, name: string): Promise<boolean> {
    const file = activeFile()
    if (!file || file.path !== path) return false
    return !!(await operation(file, async (current) => {
        await window.iter.snapshots.rename(current.path, id, name)
        return true
    }))
}

export async function deleteSnapshot(path: string, id: string): Promise<void> {
    const file = activeFile()
    if (!file || file.path !== path) return
    await operation(file, (current) => window.iter.snapshots.delete(current.path, id))
}
