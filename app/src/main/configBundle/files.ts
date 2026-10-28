import { constants, promises as fs } from 'node:fs'
import path from 'node:path'

export function allowedPath(file: string): boolean {
    return (
        file.length > 0 &&
        !file.includes('\\') &&
        file
            .split('/')
            .every(
                (part) =>
                    !!part &&
                    part !== '.' &&
                    part !== '..' &&
                    !/[<>:"|?*\x00-\x1f]/.test(part) &&
                    !/[. ]$/.test(part) &&
                    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) &&
                    !/^\.(git|svn|hg)$/i.test(part) &&
                    !/^(tmp|temp)$/i.test(part) &&
                    !/(?:\.(tmp|temp|lock|swp|swo)|~)$/i.test(part) &&
                    !/^([.~]lock|~\$)/i.test(part)
            )
    )
}

/** Reject traversal and symlinks/junctions at every existing component, including the configuration root. */
export async function safePath(root: string, relative: string): Promise<string> {
    if (relative && !allowedPath(relative)) throw new Error('同步文件路径不安全。')
    const absoluteRoot = path.resolve(root)
    const target = path.resolve(absoluteRoot, ...relative.split('/').filter(Boolean))
    if (target !== absoluteRoot && !target.startsWith(absoluteRoot + path.sep))
        throw new Error('同步路径超出了本地存储目录。')
    let current = absoluteRoot
    const components = ['', ...relative.split('/').filter(Boolean)]
    for (const part of components) {
        if (part) current = path.join(current, part)
        try {
            const stat = await fs.lstat(current)
            if (stat.isSymbolicLink()) throw new Error('同步路径包含符号链接。')
        } catch (error) {
            if (!missing(error)) throw error
        }
    }
    return target
}

export async function readLocal(root: string, relative: string, maxBytes: number): Promise<Buffer | undefined> {
    const target = await safePath(root, relative)
    let handle
    try {
        handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size > maxBytes) throw new Error('同步期间文件类型或大小发生变化，请重试。')
        // Bound reads even if an editor grows the file while it is being read.
        const chunks: Buffer[] = []
        let total = 0
        while (true) {
            const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes - total + 1))
            const { bytesRead } = await handle.read(chunk)
            if (!bytesRead) break
            total += bytesRead
            if (total > maxBytes) throw new Error('同步期间文件超出大小上限，请重试。')
            chunks.push(chunk.subarray(0, bytesRead))
        }
        return Buffer.concat(chunks, total)
    } catch (error) {
        if (missing(error)) return undefined
        throw error
    } finally {
        await handle?.close()
    }
}

export function missing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
}
