import type { JudgeEvent, TestResult, Verdict } from '../../shared/judge'
import { store, toast, updateFile } from '../state/app'
import { autoPersist, isFileTransitioning } from './files'
import { flushProblemWrites } from './problemWrites'
import { syncFileIO } from './fileIO'
import { JudgeProgressBatch } from './judgeProgress'

const api = window.iter
const runOwner = new Map<string, string>() // runId → source path
const progress = new JudgeProgressBatch((runId, results) => {
    const path = runOwner.get(runId)
    if (!path || store.get().files.find((file) => file.path === path)?.runId !== runId) return
    updateFile(path, (file) => ({ results: { ...file.results, ...results } }))
})
interface RunSlot {
    generation: number
    tail: Promise<void>
    runId: string | null
}
const slots = new Map<string, RunSlot>()
function slotFor(path: string): RunSlot {
    let slot = slots.get(path)
    if (!slot) {
        slot = { generation: 0, tail: Promise.resolve(), runId: null }
        slots.set(path, slot)
    }
    return slot
}

export function listenJudge(): void {
    api.judge.onEvent((e: JudgeEvent) => {
        const path = runOwner.get(e.runId)
        if (!path) return
        const file = store.get().files.find((f) => f.path === path)
        if (!file || file.runId !== e.runId) {
            if (e.type === 'done' || e.type === 'error') runOwner.delete(e.runId)
            return
        }
        switch (e.type) {
            case 'compile-done':
                updateFile(path, { compile: e.result })
                if (!e.result.ok) toast('编译错误', 'error')
                break
            case 'test-start':
                progress.enqueue(e.runId, { ...emptyResult(e.testId), verdict: 'RUNNING' })
                break
            case 'test-done':
                // runner reports CPU time with sub-ms ticks; whole milliseconds read better
                progress.enqueue(e.runId, { ...e.result, timeMs: Math.round(e.result.timeMs) })
                break
            case 'done':
                progress.flush(e.runId)
                updateFile(path, (f) => ({
                    runId: null,
                    lastVerdict: overall(e.summary.verdict, Object.values(f.results))
                }))
                runOwner.delete(e.runId)
                // Keep the engine id until stop() joins cleanup: done can precede lease release.
                break
            case 'error':
                progress.flush(e.runId)
                updateFile(path, { runId: null })
                runOwner.delete(e.runId)
                toast(e.message, 'error', 6000)
                break
        }
    })
}

/** Tests without an answer (NA) don't decide the overall verdict unless nothing else ran. */
function overall(engine: Verdict, results: TestResult[]): Verdict {
    if (engine !== 'NA') return engine
    const judged = results.filter((r) => r.verdict !== 'NA' && r.verdict !== 'PENDING')
    return judged.find((r) => r.verdict !== 'AC')?.verdict ?? (judged.length ? 'AC' : 'NA')
}

const emptyResult = (testId: string) => ({
    testId,
    verdict: 'PENDING' as const,
    timeMs: 0,
    exitCode: null,
    output: '',
    stderr: ''
})

export function runTests(testIds?: string[], sourcePath = store.get().activePath): Promise<void> {
    const original = store.get().files.find((f) => f.path === sourcePath)
    if (!original?.problem || store.get().closing || isFileTransitioning(original.path)) return Promise.resolve()
    const path = original.path,
        slot = slotFor(path),
        generation = ++slot.generation
    const operationId = crypto.randomUUID()
    // Claim ownership before any IPC can emit a progress event.
    updateFile(path, { runId: operationId, compile: null, lastVerdict: null })
    const current = (): boolean =>
        slot.generation === generation && store.get().files.some((f) => f.path === path && f.model === original.model)
    const job = slot.tail
        .catch(() => {})
        .then(async () => {
            if (!current()) return
            if (slot.runId) {
                const previous = slot.runId
                await api.judge.stop(previous)
                runOwner.delete(previous)
                if (slot.runId === previous) slot.runId = null
            }
            if (!current()) return
            if (store.get().debug.path === path) {
                const debug = await import('./debug')
                if (!current()) return
                await debug.stopDebug()
            }
            if (!current()) return
            await flushProblemWrites(path)
            if (!current() || original.model.isDisposed()) return
            await autoPersist(path)
            if (!current() || original.model.isDisposed()) return
            const code = original.model.getValue()
            const problem = store.get().files.find((f) => f.path === path)?.problem
            if (!problem) return
            await syncFileIO(path, code, problem)
            if (!current()) return
            await flushProblemWrites(path)
            if (!current()) return
            const ids =
                testIds ??
                store
                    .get()
                    .files.find((f) => f.path === path)!
                    .problem!.tests.filter((t) => t.enabled)
                    .map((t) => t.id)
            if (!ids.length) {
                updateFile(path, { runId: null })
                toast('没有测试点', 'info')
                return
            }
            updateFile(path, (file) => {
                const results = { ...file.results }
                for (const id of ids) results[id] = emptyResult(id)
                return { results }
            })
            runOwner.set(operationId, path)
            slot.runId = operationId
            const runId = await api.judge.run({ sourcePath: path, source: code, testIds: ids, operationId })
            progress.flush(operationId)
            // Compatibility with older development transports which allocate their own id.
            if (runOwner.has(operationId) && runId !== operationId) {
                runOwner.delete(operationId)
                runOwner.set(runId, path)
                slot.runId = runId
                if (current()) updateFile(path, { runId })
            }
            if (current()) store.set({ rightView: 'tests' })
        })
        .catch((error: Error) => {
            runOwner.delete(operationId)
            if (slot.runId === operationId) slot.runId = null
            if (current()) updateFile(path, { runId: null })
            toast(`运行失败：${error.message}`, 'error', 6000)
        })
    slot.tail = job
    return job
}

export function stopRun(sourcePath = store.get().activePath): Promise<void> {
    if (!sourcePath) return Promise.resolve()
    const slot = slotFor(sourcePath)
    if (slot.runId) progress.flush(slot.runId)
    ++slot.generation
    updateFile(sourcePath, { runId: null })
    const job = slot.tail
        .catch(() => {})
        .then(async () => {
            if (!slot.runId) return
            const previous = slot.runId
            await api.judge.stop(previous)
            runOwner.delete(previous)
            if (slot.runId === previous) slot.runId = null
        })
    slot.tail = job
    return job
}
