import { promises as fs, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

const held = new Map<string, number>()
const pruning = new Map<string, Promise<void>>()
const key = (file: string): string =>
    process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)
const inside = (parent: string, child: string): boolean => child === parent || child.startsWith(parent + path.sep)
export function holdCachePath(fileOrDirectory: string): () => void {
    const file = key(fileOrDirectory)
    held.set(file, (held.get(file) ?? 0) + 1)
    let released = false
    return () => {
        if (released) return
        released = true
        const count = (held.get(file) ?? 1) - 1
        if (count) held.set(file, count)
        else held.delete(file)
    }
}
const busy = (directory: string): boolean => {
    const dir = key(directory)
    return [...held.keys()].some((file) => inside(dir, file) || inside(file, dir))
}
interface Entry {
    directory: string
    bytes: number
    lastUsed: number
}
async function measure(directory: string): Promise<number | undefined> {
    let bytes = 0
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
        if (item.isSymbolicLink()) return undefined
        const file = path.join(directory, item.name)
        if (item.isDirectory()) {
            const child = await measure(file)
            if (child === undefined) return undefined
            bytes += child
        } else if (item.isFile()) bytes += (await fs.stat(file)).size
        else return undefined
    }
    return bytes
}
async function collect(root: string): Promise<Entry[]> {
    const entries: Entry[] = []
    async function visit(directory: string, depth: number): Promise<void> {
        if (depth > 4) return
        const items = await fs.readdir(directory, { withFileTypes: true })
        if (items.some((item) => item.isSymbolicLink())) return
        const manifest = items.find((item) => item.name === 'compile.json' && item.isFile())
        const tool = path.dirname(directory) === path.join(root, 'tools')
        if (manifest || tool) {
            const bytes = await measure(directory)
            if (bytes === undefined) return
            const info = await fs.stat(manifest ? path.join(directory, 'compile.json') : directory)
            let lastUsed = info.mtimeMs
            if (manifest) {
                try {
                    const value = JSON.parse(await fs.readFile(path.join(directory, 'compile.json'), 'utf8')) as {
                        lastUsed?: unknown
                    }
                    if (typeof value.lastUsed === 'number' && Number.isFinite(value.lastUsed)) lastUsed = value.lastUsed
                } catch {
                    /* A corrupt manifest can be reclaimed just like an expired entry. */
                }
            }
            entries.push({ directory, bytes, lastUsed })
            return
        }
        for (const item of items) if (item.isDirectory()) await visit(path.join(directory, item.name), depth + 1)
    }
    await visit(root, 0)
    return entries
}
/** Only the dedicated temporary build cache may be pruned; never follow links. */
export async function pruneBuildCache(
    options: { maxBytes?: number; maxAgeMs?: number; root?: string } = {}
): Promise<void> {
    const root = path.resolve(options.root ?? path.join(os.tmpdir(), 'iter-build'))
    const temporary = key(os.tmpdir())
    if (path.basename(root) !== 'iter-build' || !inside(temporary, key(root)) || key(root) === temporary)
        throw new Error('Refusing unsafe build cache root')
    const existing = pruning.get(key(root))
    if (existing) return existing
    const task = (async () => {
        const info = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined
            throw error
        })
        if (!info) return
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Refusing linked build cache root')
        if (key(await fs.realpath(root)) !== key(root)) throw new Error('Refusing linked build cache ancestor')
        const maxBytes = options.maxBytes ?? 2 * 1024 ** 3
        const maxAge = options.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000
        if (!Number.isFinite(maxBytes) || maxBytes < 0 || !Number.isFinite(maxAge) || maxAge < 0)
            throw new Error('Invalid build cache budget')
        const entries = (await collect(root)).sort(
            (a, b) => a.lastUsed - b.lastUsed || a.directory.localeCompare(b.directory)
        )
        let total = entries.reduce((sum, entry) => sum + entry.bytes, 0)
        const now = Date.now()
        for (const entry of entries) {
            if (busy(entry.directory) || (total <= maxBytes && now - entry.lastUsed <= maxAge)) continue
            const current = await fs.lstat(entry.directory).catch(() => undefined)
            if (!current?.isDirectory() || current.isSymbolicLink() || busy(entry.directory)) continue
            try {
                // No await between checking leases and detaching the entry. A new lookup
                // now observes a miss instead of adopting a file being deleted.
                const retired = path.join(root, '.evicted-' + randomUUID())
                renameSync(entry.directory, retired)
                await fs.rm(retired, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 })
                total -= entry.bytes
            } catch {
                /* Windows may still have a recently released executable open. Retry next pass. */
            }
        }
    })()
    pruning.set(key(root), task)
    try {
        await task
    } finally {
        if (pruning.get(key(root)) === task) pruning.delete(key(root))
    }
}
