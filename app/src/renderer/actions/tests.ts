import type { ProblemSettingsPatch } from '../../shared/problem'
import type { JudgeSourceFile } from '../../shared/problem'
import { checkerSettingsPatch } from '../../shared/checkerSelection'
import { activeFile, isDebugging, store, toast, updateFile } from '../state/app'
import { reloadProblem } from './files'
import {
    enqueueProblemSettings,
    enqueueTestWrite,
    flushProblemWrites,
    saveProblemSettings,
    testIsDeleting,
    withProblemMutation,
    withTestDeletion
} from './problemWrites'

const api = window.iter

export const saveProblem = saveProblemSettings
export const editProblemSettings = (path: string, patch: ProblemSettingsPatch): void => {
    const state = store.get(),
        file = state.files.find((file) => file.path === path)
    if (
        state.closing ||
        file?.runId ||
        file?.terminalRunId ||
        file?.terminalPending ||
        (state.debug.path === path && isDebugging(state))
    ) {
        toast('请先结束运行或调试，再修改运行配置', 'info')
        return
    }
    enqueueProblemSettings(path, patch)
}
export { flushProblemWrites }

export async function addTest(input = '', answer = ''): Promise<void> {
    const f = activeFile()
    if (!f) return
    await withProblemMutation(f.path, async (flush) => {
        await flush()
        const id = await api.problem.writeTest(f.path, { input, answer })
        await reloadProblem(f.path)
        store.set((s) => ({ expanded: { ...s.expanded, [`${f.path}#${id}`]: true } }))
    })
}

/** Debounced edit of a test's input/answer from the inline editors. */
export function editTest(
    id: string,
    patch: { input?: string; answer?: string },
    sourcePath = store.get().activePath
): void {
    const f = store.get().files.find((file) => file.path === sourcePath)
    if (!f || f.transitioning || testIsDeleting(f.path, id)) return
    const original = f.tests.find((t) => t.id === id)
    if (!original || original.truncated || original.previewLoaded === false) return
    const tests = f.tests.map((t) => (t.id === id ? { ...t, ...patch } : t))
    updateFile(f.path, { tests })
    const t = tests.find((x) => x.id === id)!
    enqueueTestWrite(f.path, { id, name: t.name, input: t.input, answer: t.answer })
}

export async function deleteTests(ids: string[], sourcePath = store.get().activePath): Promise<void> {
    const f = store.get().files.find((file) => file.path === sourcePath)
    if (!f || !ids.length) return
    await withProblemMutation(f.path, async () => {
        await withTestDeletion(f.path, ids, () => api.problem.deleteTests(f.path, ids))
        const removed = new Set(ids)
        // A failed refresh must not leave deleted cards writable and able to recreate their files.
        updateFile(f.path, (file) => {
            const results = { ...file.results }
            for (const id of ids) delete results[id]
            return {
                results,
                tests: file.tests.filter((test) => !removed.has(test.id)),
                problem: file.problem
                    ? { ...file.problem, tests: file.problem.tests.filter((test) => !removed.has(test.id)) }
                    : null
            }
        })
        await reloadProblem(f.path)
    })
}

export async function toggleTest(id: string, enabled: boolean, sourcePath = store.get().activePath): Promise<void> {
    const f = store.get().files.find((file) => file.path === sourcePath)
    if (!f?.problem) return
    await withProblemMutation(f.path, async (flush) => {
        await flush()
        await api.problem.updateTest(f.path, id, { enabled })
        updateFile(f.path, (file) => ({
            problem: file.problem
                ? { ...file.problem, tests: file.problem.tests.map((t) => (t.id === id ? { ...t, enabled } : t)) }
                : null
        }))
        updateFile(f.path, (file) => ({ tests: file.tests.map((t) => (t.id === id ? { ...t, enabled } : t)) }))
    })
}

/** Keep the answer intact; only this test's next run changes comparison policy. */
export async function setCompareOutput(
    id: string,
    compareOutput: boolean,
    sourcePath = store.get().activePath
): Promise<void> {
    const f = store.get().files.find((file) => file.path === sourcePath)
    if (!f?.problem || testIsDeleting(f.path, id)) return
    const state = store.get()
    if (state.closing || f.runId || f.terminalRunId || (state.debug.path === f.path && isDebugging(state)))
        throw new Error('请先结束运行或调试，再切换输出比较')
    await withProblemMutation(f.path, async (flush) => {
        await flush()
        await api.problem.updateTest(f.path, id, { compareOutput })
        updateFile(f.path, (file) => ({
            problem: file.problem
                ? {
                      ...file.problem,
                      tests: file.problem.tests.map((test) => (test.id === id ? { ...test, compareOutput } : test))
                  }
                : null,
            tests: file.tests.map((test) => (test.id === id ? { ...test, compareOutput } : test)),
            results: Object.fromEntries(Object.entries(file.results).filter(([testId]) => testId !== id)),
            lastVerdict: null
        }))
    })
}

/** Use the program's output of a test as its expected answer. */
export async function acceptOutput(id: string, sourcePath = store.get().activePath): Promise<void> {
    const f = store.get().files.find((file) => file.path === sourcePath)
    const r = f?.results[id]
    if (!f || !r || r.truncated) return
    editTest(id, { answer: r.output }, f.path)
    toast('已将本次输出设为期望答案', 'success')
}

/** Dropped folder / archive / loose files → import preview dialog. */
export async function importPaths(paths: string[], sourcePath = store.get().activePath): Promise<void> {
    const f = store.get().files.find((file) => file.path === sourcePath)
    if (!f) {
        toast('先打开一个 .cpp', 'info')
        return
    }
    try {
        const preview = await api.importer.preview(paths.length === 1 ? paths[0] : paths)
        if (store.get().closing) return
        if (!preview.pairs.length && !preview.extras.length) {
            toast('没有识别到测试数据', 'error')
            return
        }
        store.set({ dialog: { kind: 'import', preview, sourcePath: f.path } })
    } catch (e) {
        toast(`导入失败：${(e as Error).message}`, 'error', 6000)
    }
}

/**
 * Dropped onto the tests panel: import straight away (append), and let a checker / interactor in
 * the data turn the problem into SPJ / interactive automatically.
 */
export async function importDirect(paths: string[], sourcePath = store.get().activePath): Promise<void> {
    const f = store.get().files.find((file) => file.path === sourcePath)
    if (!f) return
    try {
        const r = await withProblemMutation(f.path, async (flush) => {
            const preview = await api.importer.preview(paths.length === 1 ? paths[0] : paths)
            if (!preview.pairs.length && !preview.extras.length) {
                toast('没有识别到测试数据', 'error')
                return null
            }
            await flush()
            const result = await api.importer.apply({ sourcePath: f.path, preview, replace: false, attachExtras: true })
            await reloadProblem(f.path)
            return result
        })
        if (!r) return
        const mode = store.get().files.find((file) => file.path === f.path)?.problem?.mode
        const extra = mode === 'spj' ? ' · 已选择自定义 checker' : mode === 'interactive' ? ' · 已设为交互题' : ''
        toast(`已导入 ${r.added} 个测试点${extra}`, 'success')
    } catch (e) {
        toast(`导入失败：${(e as Error).message}`, 'error', 6000)
    }
}

/** A text file dropped into one IO box replaces that box's content. */
export async function loadIntoTest(
    id: string,
    field: 'input' | 'answer',
    path: string,
    sourcePath = store.get().activePath
): Promise<void> {
    try {
        const text = await api.fs.readText(path)
        editTest(id, { [field]: text }, sourcePath)
    } catch (e) {
        toast(`读取失败：${(e as Error).message}`, 'error')
    }
}

/** Both supported source protocols use the same attachment and checker settings. */
export async function saveCheckerCode(
    code: string | null,
    sourcePath = store.get().activePath,
    args?: string
): Promise<void> {
    const f = store.get().files.find((item) => item.path === sourcePath)
    if (!f?.problem) return
    await withProblemMutation(f.path, async (flush) => {
        await flush()
        const rel = code === null ? undefined : await api.problem.attachCode(f.path, code)
        const p = store.get().files.find((item) => item.path === f.path)?.problem
        if (!p) return
        await saveProblem(f.path, checkerSettingsPatch(p, { kind: 'custom', ...(rel ? { path: rel } : {}), args }))
        toast('已设置自定义 checker', 'success')
    })
}

export async function saveInteractorCode(files: JudgeSourceFile[], sourcePath: string, args?: string): Promise<void> {
    const f = store.get().files.find((item) => item.path === sourcePath)
    if (!f?.problem) throw new Error('题目已关闭')
    await withProblemMutation(f.path, async (flush) => {
        await flush()
        const problem = await api.problem.writeInteractor(f.path, files, args)
        updateFile(f.path, { problem })
        await reloadProblem(f.path)
        toast('已设置交互器', 'success')
    })
}

export async function attachJudgeFile(
    role: 'checker' | 'interactor',
    file?: string,
    sourcePath = store.get().activePath
): Promise<void> {
    const f = store.get().files.find((item) => item.path === sourcePath)
    if (!f?.problem) return
    const picked =
        file ??
        (
            await api.fs.openFileDialog({
                filters: [
                    { name: role === 'checker' ? 'Checker' : 'Interactor', extensions: ['cpp', 'cc', 'exe', '*'] }
                ]
            })
        )[0]
    if (!picked) return
    await withProblemMutation(f.path, async (flush) => {
        await flush()
        const rel = await api.problem.attachFile(f.path, picked, role)
        const p = store.get().files.find((item) => item.path === f.path)?.problem
        if (!p) return
        const next: ProblemSettingsPatch =
            role === 'checker'
                ? checkerSettingsPatch(p, { kind: 'custom', path: rel })
                : { mode: 'interactive', interactor: { path: rel, args: p.interactor?.args } }
        await saveProblem(f.path, next)
        toast(role === 'checker' ? `已选择自定义 checker：${rel}` : `已设置交互器：${rel}`, 'success')
    })
}
