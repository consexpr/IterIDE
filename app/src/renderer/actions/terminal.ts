import { store, toast, updateFile } from '../state/app'
import { autoPersist, isFileTransitioning } from './files'
import { flushProblemWrites } from './problemWrites'

interface Slot {
    generation: number
    id: string | null
    tail: Promise<void>
}
const slots = new Map<string, Slot>()
function slotFor(path: string): Slot {
    let slot = slots.get(path)
    if (!slot) {
        slot = { generation: 0, id: null, tail: Promise.resolve() }
        slots.set(path, slot)
    }
    return slot
}

export function listenTerminal(): () => void {
    return window.iter.terminal.onExit(({ runId }) => {
        for (const file of store.get().files)
            if (file.terminalRunId === runId) updateFile(file.path, { terminalRunId: null, terminalPending: false })
        for (const slot of slots.values()) if (slot.id === runId) slot.id = null
    })
}

/** Compile the current editor snapshot, then let the user type in a real console. */
export function runTerminal(sourcePath = store.get().activePath): Promise<void> {
    const original = store.get().files.find((file) => file.path === sourcePath)
    if (!original || store.get().closing || isFileTransitioning(original.path)) return Promise.resolve()
    const path = original.path,
        slot = slotFor(path),
        generation = ++slot.generation
    const operationId = crypto.randomUUID()
    updateFile(path, { terminalRunId: operationId, terminalPending: true, compile: null })
    const current = (): boolean =>
        slot.generation === generation &&
        !store.get().closing &&
        !isFileTransitioning(path) &&
        store.get().files.some((file) => file.model === original.model)
    // Abort the previous compiler immediately, before joining its promise.
    const stopped = (slot.id ? window.iter.terminal.stop(slot.id) : Promise.resolve()).then(
        () => ({ ok: true as const }),
        (error) => ({ ok: false as const, error })
    )
    const job = slot.tail
        .catch(() => {})
        .then(async () => {
            const previous = await stopped
            if (!previous.ok) throw previous.error
            if (!current()) return
            await flushProblemWrites(path)
            if (!current() || original.model.isDisposed()) return
            await autoPersist(path)
            if (!current() || original.model.isDisposed()) return
            slot.id = operationId
            const result = await window.iter.terminal.run({
                sourcePath: path,
                source: original.model.getValue(),
                operationId
            })
            if (!current()) {
                if (result.launched) await window.iter.terminal.stop(result.runId)
                return
            }
            updateFile(path, { compile: result.compile, terminalPending: false })
            if (!result.launched) {
                slot.id = null
                updateFile(path, { terminalRunId: null })
                if (!result.cancelled) {
                    store.set({ rightView: 'tests', sideCollapsed: false })
                    toast(result.error ?? (result.compile.ok ? '终端启动失败' : '编译错误'), 'error', 6000)
                }
            }
        })
        .catch((error: Error) => {
            if (!current()) return
            slot.id = null
            updateFile(path, { terminalRunId: null, terminalPending: false })
            toast(`终端运行失败：${error.message}`, 'error', 6000)
        })
    slot.tail = job
    return job
}

export async function stopTerminal(sourcePath = store.get().activePath): Promise<void> {
    if (!sourcePath) return
    const slot = slots.get(sourcePath)
    if (!slot) return
    const generation = ++slot.generation,
        id = slot.id,
        tail = slot.tail
    updateFile(sourcePath, { terminalRunId: null, terminalPending: false })
    if (id) await window.iter.terminal.stop(id)
    await tail
    if (slot.generation === generation && slot.id === id) slot.id = null
}
