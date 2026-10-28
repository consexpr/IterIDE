import { promises as fs } from 'node:fs'
import path from 'node:path'

const bundleId = /^[a-f\d-]{36}$/i
export const resourceGraceMs = 60 * 60 * 1000

/** Called under the problem lock after a successful operation. New/uncommitted selections get a grace period. */
export async function collectResources(
    directory: string,
    config: unknown,
    leased: boolean,
    now = Date.now()
): Promise<void> {
    if (leased) return
    const root = path.resolve(directory)
    const entries = await fs.readdir(root, { withFileTypes: true })
    if (entries.some((entry) => /^\.import-/.test(entry.name))) return
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !/^\.resources-[a-f\d-]{36}$/i.test(entry.name)) continue
        const target = path.resolve(root, entry.name)
        if (path.dirname(target) !== root) throw new Error('无效的缓存回收路径')
        if ((await fs.lstat(target)).mtimeMs + resourceGraceMs <= now)
            await fs.rm(target, { recursive: true, force: true })
    }
    const referenced = new Set<string>()
    const visit = (value: unknown): void => {
        if (typeof value === 'string') {
            for (const match of value.replaceAll('\\', '/').matchAll(/(?:^|\/)resources\/([a-f\d-]{36})(?:\/|$)/gi))
                referenced.add(match[1].toLowerCase())
        } else if (Array.isArray(value)) value.forEach(visit)
        else if (value && typeof value === 'object') Object.values(value).forEach(visit)
    }
    visit(config)
    const resources = path.join(root, 'resources')
    // Never follow a substituted resources directory or bundle symlink when pruning.
    const info = await fs.lstat(resources).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
    })
    if (!info?.isDirectory() || info.isSymbolicLink()) return
    for (const entry of await fs.readdir(resources, { withFileTypes: true })) {
        if (
            !entry.isDirectory() ||
            entry.isSymbolicLink() ||
            !bundleId.test(entry.name) ||
            referenced.has(entry.name.toLowerCase())
        )
            continue
        const target = path.resolve(resources, entry.name)
        if (path.dirname(target) !== resources) throw new Error('无效的缓存回收路径')
        if ((await fs.lstat(target)).mtimeMs + resourceGraceMs > now) continue
        await fs.rm(target, { recursive: true, force: true })
    }
}
