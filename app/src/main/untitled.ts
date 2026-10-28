import { promises as fs } from 'node:fs'
import path from 'node:path'
import { discardSource } from './problem/store'
import { pathKey } from './problem/identity'
import { storeRoot } from './problem/root'

/** Unsaved new files live here as real files, so judge / debug / clangd treat them like any other. */
export function untitledDir(): string {
    return path.join(storeRoot(), 'untitled')
}
export function untitledPath(index: number): string {
    if (!Number.isInteger(index) || index < 1) throw new Error('无效的未命名序号')
    return path.join(untitledDir(), `Untitled-${index}.cpp`)
}
export function isUntitledPath(file: string): boolean {
    return (
        pathKey(path.dirname(file)) === pathKey(untitledDir()) && /^Untitled-[1-9]\d*\.cpp$/i.test(path.basename(file))
    )
}

/** A fresh slot: leftovers of a crashed session are overwritten, together with their stale tests. */
export async function createUntitled(index: number, text: string): Promise<string> {
    const file = untitledPath(index)
    await discardSource(file)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text, 'utf8')
    return file
}

export async function discardUntitled(file: string): Promise<void> {
    if (!isUntitledPath(file)) throw new Error('不是未命名文件')
    await discardSource(file)
    await fs.rm(file, { force: true })
}

/** Remove managed files nobody restored (closed with the window gone, or a crash before the first session write). */
export async function sweepUntitled(keep: string[]): Promise<void> {
    const keys = new Set(keep.map(pathKey))
    const names = await fs.readdir(untitledDir()).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return []
        throw e
    })
    for (const name of names) {
        const file = path.join(untitledDir(), name)
        if (isUntitledPath(file) && !keys.has(pathKey(file))) await discardUntitled(file)
    }
}
