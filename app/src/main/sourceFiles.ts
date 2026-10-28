import { promises as fs } from 'node:fs'
import path from 'node:path'
import { atomicWrite } from './problem/atomic'

const normalize = (text: string): string => text.replace(/\r\n?/g, '\n')
const writes = new Map<string, Promise<void>>()

export class SourceConflictError extends Error {
    constructor(readonly actual: string | null) {
        super('磁盘文件已被修改或删除，保存已停止，编辑内容仍保留。')
    }
}

async function diskText(file: string): Promise<string | null> {
    try {
        return normalize(await fs.readFile(file, 'utf8'))
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
    }
}

/** Stage complete contents before replacing the source, preserving its ITER identity. */
export async function writeSourceText(file: string, content: string, expected?: string | null): Promise<void> {
    const absolute = path.resolve(file)
    // Saving through a symlink must update its target, not replace the link itself.
    const target = await fs.realpath(absolute).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return absolute
    })
    if (target === absolute) {
        const entry = await fs.lstat(absolute).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
            return null
        })
        if (entry?.isSymbolicLink()) throw new Error('链接目标不可用，保存已停止，原链接已保留。')
    }
    const key = process.platform === 'win32' ? target.toLowerCase() : target
    const job = (writes.get(key) ?? Promise.resolve())
        .catch(() => {})
        .then(async () => {
            const check = async (): Promise<void> => {
                if (expected === undefined) return
                const actual = await diskText(target)
                if (actual !== expected) throw new SourceConflictError(actual)
            }
            await check()
            const metadata = await fs.stat(target).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== 'ENOENT') throw error
                return null
            })
            await atomicWrite(target, content, async (temporary) => {
                if (metadata) {
                    // Preserve the Windows ADS used to bind source files to their test data.
                    if (process.platform === 'win32') {
                        const identity = await fs
                            .readFile(`${target}:iter.id`)
                            .catch((error: NodeJS.ErrnoException) => {
                                if (error.code !== 'ENOENT' && error.code !== 'EINVAL' && error.code !== 'ENOTSUP')
                                    throw error
                                return null
                            })
                        if (identity) {
                            const handle = await fs.open(`${temporary}:iter.id`, 'wx')
                            try {
                                await handle.writeFile(identity)
                                await handle.sync()
                            } finally {
                                await handle.close()
                            }
                        }
                    }
                    await fs.chmod(temporary, metadata.mode)
                }
                // Check again after staging: another editor may have written while we were awaiting IO.
                await check()
            })
        })
    writes.set(key, job)
    try {
        await job
    } finally {
        if (writes.get(key) === job) writes.delete(key)
    }
}
