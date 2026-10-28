import { openFile } from '../../actions/files'
import { importFolder } from '../../actions/folders'
import { attachJudgeFile, importPaths } from '../../actions/tests'
import { store } from '../../state/app'

const CPP = /\.(cpp|cc|cxx)$/i
const JUDGE_FILE = /(checker|chk|spj|check|interactor|interact)\w*\.(cpp|cc|exe)$/i

/** .cpp → open as problem; a lone checker/interactor → attach; anything else → test data import. */
export async function routeDrop(paths: string[]): Promise<void> {
    if (store.get().closing) return
    const sourcePath = store.get().activePath
    const judge = paths.length === 1 ? JUDGE_FILE.exec(paths[0]) : null
    if (judge && store.get().activePath)
        return attachJudgeFile(/interact/i.test(judge[1]) ? 'interactor' : 'checker', paths[0])
    if (paths.every((p) => CPP.test(p))) {
        for (const p of paths) await openFile(p)
        return
    }
    // a problem folder / contest folder sets everything up; other folders fall back to data import
    if (paths.length === 1 && !/\.zip$/i.test(paths[0]) && (await importFolder(paths[0]))) return
    await importPaths(paths, sourcePath)
}

/** OS paths of the files in a drop event. */
export const droppedPaths = (e: React.DragEvent): string[] =>
    [...e.dataTransfer.files].map((f) => window.iter.fs.pathForFile(f)).filter(Boolean)

export const hasFiles = (e: React.DragEvent): boolean => e.dataTransfer.types.includes('Files')

let depth = 0
/** Inner drop targets call this after handling a drop themselves (they stop propagation). */
export function endDrag(): void {
    depth = 0
    store.set({ dragOver: false })
}

/** Handlers for the app root; shows the drop overlay while OS files hover the window. */
export function useFileDrop() {
    return {
        onDragEnter: (e: React.DragEvent) => {
            if (!hasFiles(e)) return
            depth++
            store.set({ dragOver: true })
        },
        onDragOver: (e: React.DragEvent) => {
            if (hasFiles(e)) e.preventDefault()
        },
        onDragLeave: () => {
            if (--depth > 0) return
            endDrag()
        },
        onDrop: (e: React.DragEvent) => {
            e.preventDefault()
            endDrag()
            const paths = droppedPaths(e)
            if (paths.length) void routeDrop(paths)
        }
    }
}
