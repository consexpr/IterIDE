// Whole-problem import: an exam folder (data + checker/interactor/grader + the user's code) becomes
// a ready problem in one step; a contest folder (one subfolder per problem) becomes all of them.
import type { ProblemFolderPreview } from '../../shared/importer'
import { store, toast } from '../state/app'
import { openFile, reloadProblem } from './files'
import { withProblemMutation, withTestReplacement } from './problemWrites'

const api = window.iter

/** What the problem ended up as, for the toast. */
function describe(p: ProblemFolderPreview, added: number): string {
    const kind = p.grader ? ' · grader' : p.interactor ? ' · 交互' : p.checker ? ' · SPJ' : ''
    return `${p.name}：${added} 个测试点${kind}`
}

async function initialCode(p: ProblemFolderPreview): Promise<string> {
    if (p.template) return api.fs.readText(p.template).catch(() => store.get().settings.template.replace('$0', ''))
    return store.get().settings.template.replace('$0', '')
}

const join = (dir: string, name: string): string => `${dir}${dir.includes('\\') ? '\\' : '/'}${name}`

/** Pick the solution to bind: the already-bound one, the only one, or a new `<name>.cpp`. */
function pickSource(p: ProblemFolderPreview): string | null {
    if (p.boundSource) return p.boundSource
    if (p.sources.length === 1) return p.sources[0]
    if (p.sources.length === 0) return join(p.dir, `${p.name}.cpp`)
    return null // ambiguous: ask
}

export async function applyProblemFolder(
    p: ProblemFolderPreview,
    sourcePath: string,
    open = true,
    replaceTests = false
): Promise<number> {
    return withProblemMutation(sourcePath, async (flush) => {
        const apply = async () => {
            const exists = await api.fs.exists(sourcePath)
            return api.importer.applyFolder({
                problem: p,
                sourcePath,
                initialCode: exists ? undefined : await initialCode(p),
                link: true,
                replaceTests
            })
        }
        let r: Awaited<ReturnType<typeof apply>>
        if (replaceTests) r = await withTestReplacement(sourcePath, apply, () => reloadProblem(sourcePath))
        else {
            await flush()
            r = await apply()
        }
        if (open) {
            await openFile(r.sourcePath)
            await reloadProblem(r.sourcePath)
        }
        return r.added
    })
}

/**
 * A dropped folder. Returns false when it is neither a problem nor a contest folder, so the caller
 * can fall back to plain test-data import.
 */
export async function importFolder(dir: string): Promise<boolean> {
    const preview = await api.importer.previewFolder(dir).catch(() => null)
    if (!preview || preview.kind === 'none') return false
    if (preview.kind === 'contest') {
        let done = 0
        for (const p of preview.problems) {
            await applyProblemFolder(p, pickSource(p) ?? p.sources[0])
            done++
        }
        toast(`已配置 ${done} 道题`, 'success')
        return true
    }
    const p = preview.problems[0]
    const src = pickSource(p)
    if (!src) {
        store.set({ dialog: { kind: 'pickSource', problem: p } })
        return true
    }
    const added = await applyProblemFolder(p, src)
    toast(describe(p, added), 'success')
    return true
}

/** Dropped on the tests panel: a problem folder's data/checker/grader go into the *current* problem. */
export async function importFolderIntoActive(dir: string, sourcePath = store.get().activePath): Promise<boolean> {
    const f = store.get().files.find((file) => file.path === sourcePath)
    if (!f) return false
    const preview = await api.importer.previewFolder(dir).catch(() => null)
    if (store.get().closing) return true
    if (!preview || preview.kind !== 'problem') return false
    const p = preview.problems[0]
    const added = await applyProblemFolder(p, f.path, false)
    await reloadProblem(f.path)
    toast(describe(p, added), 'success')
    return true
}
