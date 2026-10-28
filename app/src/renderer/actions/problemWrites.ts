import type { ProblemConfig, ProblemSettingsPatch, TestCaseData } from '../../shared/problem'
import { store, toast, updateFile } from '../state/app'

/** A debounce owns its promise too: clearing a timer cannot cancel an IPC already in flight. */
export class DeferredWrite<T> {
    private revision = 0
    private persisted = 0
    private pending?: { revision: number; value: T }
    private latest?: T
    private inflight?: Promise<void>
    private inflightValue?: T
    private timer?: ReturnType<typeof setTimeout>
    private deleting = false

    constructor(
        private readonly write: (value: T, current: () => boolean) => Promise<void>,
        private readonly merge: (older: T, newer: T) => T,
        private readonly onError: (error: unknown) => void
    ) {}

    get blocked(): boolean {
        return this.deleting
    }
    get idle(): boolean {
        return !this.pending && !this.inflight
    }
    get overlay(): T | undefined {
        if (this.deleting) return undefined
        return this.inflightValue === undefined
            ? this.pending?.value
            : this.pending
              ? this.merge(this.inflightValue, this.pending.value)
              : this.inflightValue
    }

    enqueue(value: T, delay: number): void {
        if (this.deleting) throw new Error('测试点正在删除')
        this.latest = this.latest === undefined ? value : this.merge(this.latest, value)
        this.pending = {
            revision: ++this.revision,
            value: this.pending ? this.merge(this.pending.value, value) : value
        }
        clearTimeout(this.timer)
        this.timer = setTimeout(() => {
            this.timer = undefined
            void this.flush().catch(this.onError)
        }, delay)
    }

    async flush(): Promise<void> {
        clearTimeout(this.timer)
        this.timer = undefined
        while (!this.deleting && this.persisted < this.revision) {
            if (this.inflight) {
                await this.inflight
                continue
            }
            const next = this.pending
            if (!next) return
            this.pending = undefined
            this.inflightValue = next.value
            const job = Promise.resolve()
                .then(() => this.write(next.value, () => !this.deleting && this.revision === next.revision))
                .then(() => {
                    this.persisted = next.revision
                })
                .catch((error) => {
                    if (!this.deleting)
                        this.pending = this.pending
                            ? { ...this.pending, value: this.merge(next.value, this.pending.value) }
                            : next
                    throw error
                })
            this.inflight = job
            try {
                await job
            } finally {
                if (this.inflight === job) {
                    this.inflight = undefined
                    this.inflightValue = undefined
                }
            }
        }
    }

    /** Blocks new edits first, then waits for all writes which cannot be cancelled. */
    async beginDelete(): Promise<void> {
        this.deleting = true
        clearTimeout(this.timer)
        this.timer = undefined
        this.pending = undefined
        await this.inflight?.catch(() => {})
    }

    restoreAfterDeleteFailure(): void {
        this.deleting = false
        if (this.latest !== undefined) this.pending = { revision: ++this.revision, value: this.latest }
    }
}

interface TestWrite {
    id: string
    name?: string
    input: string
    answer: string
}
const tests = new Map<string, { path: string; id: string; queue: DeferredWrite<TestWrite> }>()
const settings = new Map<string, DeferredWrite<ProblemSettingsPatch>>()
const mutations = new Map<string, Set<Promise<unknown>>>()
const replacements = new Map<string, number>()
const testKey = (path: string, id: string): string => JSON.stringify([path, id])
const report = (error: unknown): void =>
    toast(`题目数据保存失败：${(error as Error).message}，修改仍保留，可重试`, 'error', 6000)

function testQueue(path: string, id: string): DeferredWrite<TestWrite> {
    const key = testKey(path, id)
    let entry = tests.get(key)
    if (!entry) {
        const queue = new DeferredWrite<TestWrite>(
            async (value) => {
                await window.iter.problem.writeTest(path, value)
            },
            (_older, newer) => newer,
            report
        )
        entry = { path, id, queue }
        tests.set(key, entry)
    }
    return entry.queue
}

export function testIsDeleting(path: string, id: string): boolean {
    return replacements.has(path) || (tests.get(testKey(path, id))?.queue.blocked ?? false)
}
export function enqueueTestWrite(path: string, value: TestWrite): void {
    if (replacements.has(path)) throw new Error('题目正在替换测试数据')
    testQueue(path, value.id).enqueue(value, 400)
}

function settingsQueue(path: string): DeferredWrite<ProblemSettingsPatch> {
    let queue = settings.get(path)
    if (!queue) {
        queue = new DeferredWrite<ProblemSettingsPatch>(
            async (patch, current) => {
                const saved = await window.iter.problem.patch(path, patch)
                if (current())
                    updateFile(path, (file) => {
                        if (!file.problem) return {}
                        // Only this operation's settings fields are authoritative; tests have their own lifecycle.
                        const fields = Object.fromEntries(
                            Object.keys(patch).map((key) => [key, saved[key as keyof ProblemSettingsPatch]])
                        )
                        return { problem: { ...file.problem, ...fields } }
                    })
                void window.iter.lsp.refreshCompileFlags(path).catch(() => {})
            },
            (older, newer) => ({ ...older, ...newer }),
            report
        )
        settings.set(path, queue)
    }
    return queue
}

export function enqueueProblemSettings(path: string, patch: ProblemSettingsPatch, delay = 300): void {
    if (store.get().files.find((file) => file.path === path)?.transitioning && !mutations.has(path)) {
        toast('正在保存文件，请稍后修改题目数据', 'info')
        return
    }
    updateFile(path, (file) => ({ problem: file.problem ? { ...file.problem, ...patch } : null }))
    settingsQueue(path).enqueue(patch, delay)
}

export async function saveProblemSettings(path: string, patch: ProblemSettingsPatch): Promise<void> {
    enqueueProblemSettings(path, patch, 0)
    await settingsQueue(path).flush()
}

async function flushQueuedWrites(path?: string): Promise<void> {
    const jobs = [...settings].filter(([p]) => path === undefined || p === path).map(([, queue]) => queue.flush())
    jobs.push(
        ...[...tests.values()]
            .filter((entry) => path === undefined || entry.path === path)
            .map((entry) => entry.queue.flush())
    )
    await Promise.all(jobs)
}

/** Register before yielding, so close/run also waits for accepted imports and metadata changes. */
export function withProblemMutation<T>(path: string, action: (flush: () => Promise<void>) => Promise<T>): Promise<T> {
    if (store.get().files.find((file) => file.path === path)?.transitioning)
        return Promise.reject(new Error('正在保存文件，请稍后修改题目数据'))
    let pending = mutations.get(path)
    if (!pending) {
        pending = new Set()
        mutations.set(path, pending)
    }
    const registered = pending
    const job = Promise.resolve()
        .then(() => action(() => flushQueuedWrites(path)))
        .finally(() => {
            registered.delete(job)
            if (!registered.size && mutations.get(path) === registered) mutations.delete(path)
        })
    registered.add(job)
    return job
}

export async function flushProblemWrites(path?: string): Promise<void> {
    for (;;) {
        const active = [...mutations].filter(([p]) => path === undefined || p === path).flatMap(([, jobs]) => [...jobs])
        await Promise.all(active)
        await flushQueuedWrites(path)
        if (
            ![...mutations.keys()].some((p) => path === undefined || p === path) &&
            [...settings].filter(([p]) => path === undefined || p === path).every(([, queue]) => queue.idle) &&
            [...tests.values()]
                .filter((entry) => path === undefined || entry.path === path)
                .every((entry) => entry.queue.idle)
        )
            return
    }
}

/** A disk refresh must not erase edits accepted while it was awaiting IPC. */
export function overlayProblemWrites(
    path: string,
    problem: ProblemConfig,
    data: TestCaseData[]
): { problem: ProblemConfig; tests: TestCaseData[] } {
    return {
        problem: { ...problem, ...settings.get(path)?.overlay },
        tests: data.map((test) => {
            const pending = tests.get(testKey(path, test.id))?.queue.overlay
            return pending
                ? {
                      ...test,
                      input: pending.input,
                      answer: pending.answer,
                      inputSize: new TextEncoder().encode(pending.input).byteLength,
                      answerSize: new TextEncoder().encode(pending.answer).byteLength,
                      truncated: false,
                      previewLoaded: true
                  }
                : test
        })
    }
}

export async function withTestDeletion<T>(path: string, ids: string[], remove: () => Promise<T>): Promise<T> {
    const queues = ids.map((id) => testQueue(path, id))
    // beginDelete marks every entry synchronously before yielding.
    await Promise.all(queues.map((queue) => queue.beginDelete()))
    try {
        const result = await remove()
        for (const id of ids) tests.delete(testKey(path, id))
        return result
    } catch (error) {
        queues.forEach((queue) => queue.restoreAfterDeleteFailure())
        throw error
    }
}

/** Replacement is deletion too, even if its dialog was dismissed while IPC was in flight. */
export async function withTestReplacement<T>(
    path: string,
    replace: () => Promise<T>,
    refresh: () => Promise<void>
): Promise<T> {
    replacements.set(path, (replacements.get(path) ?? 0) + 1)
    try {
        // Preserve existing edits before the transaction; block later edits until fresh rows arrive.
        await flushQueuedWrites(path)
        const file = store.get().files.find((item) => item.path === path)
        const ids = [
            ...new Set([
                ...(file?.tests.map((test) => test.id) ?? []),
                ...(file?.problem?.tests.map((test) => test.id) ?? []),
                ...[...tests.values()].filter((entry) => entry.path === path).map((entry) => entry.id)
            ])
        ]
        const result = await withTestDeletion(path, ids, replace)
        // A failed refresh must not leave stale cards capable of recreating committed deletions.
        const removed = new Set(ids)
        updateFile(path, (current) => ({
            tests: current.tests.filter((test) => !removed.has(test.id)),
            results: Object.fromEntries(Object.entries(current.results).filter(([id]) => !removed.has(id))),
            problem: current.problem
                ? { ...current.problem, tests: current.problem.tests.filter((test) => !removed.has(test.id)) }
                : null
        }))
        await refresh()
        return result
    } finally {
        const remaining = (replacements.get(path) ?? 1) - 1
        if (remaining) replacements.set(path, remaining)
        else replacements.delete(path)
    }
}

/** Call only after a successful close/flush; failed queues must remain available for retry. */
export function forgetProblemWrites(path: string): void {
    settings.delete(path)
    for (const [key, entry] of tests) if (entry.path === path) tests.delete(key)
}
