import { constants, promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { missing, readLocal, safePath } from '../configBundle/files'
import { blobSha } from './github'

export function conflictName(relative: string): string {
    const ext = path.posix.extname(relative)
    const stem = ext ? relative.slice(0, -ext.length) : relative
    const host =
        os
            .hostname()
            .replace(/[^a-zA-Z0-9_-]/g, '_')
            .slice(0, 48) || 'device'
    const date = new Date().toISOString().replace(/[:.]/g, '-')
    return `${stem}.conflict-${host}-${date}-${randomUUID().slice(0, 8)}${ext}`
}

/** Moving the actual file captures saves that happen after the network snapshot was taken. */
async function moveAside(root: string, relative: string): Promise<string | undefined> {
    const original = await safePath(root, relative)
    const backup = conflictName(relative)
    const target = await safePath(root, backup)
    // Reserve the unique destination exclusively before rename, which can overwrite on POSIX.
    await fs.writeFile(target, '', { flag: 'wx', mode: 0o600 })
    try {
        await fs.rename(original, target)
        return backup
    } catch (error) {
        await fs.rm(target, { force: true })
        if (missing(error)) return undefined
        throw error
    }
}

async function restoreIfMissing(root: string, relative: string, backup: string): Promise<boolean> {
    try {
        await fs.copyFile(await safePath(root, backup), await safePath(root, relative), constants.COPYFILE_EXCL)
        return true
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw error
    }
}

async function publish(temporary: string, target: string): Promise<void> {
    try {
        await fs.link(temporary, target)
    } catch (error) {
        if (
            !['EPERM', 'EOPNOTSUPP', 'ENOSYS', 'ENOTSUP', 'EXDEV'].includes((error as NodeJS.ErrnoException).code ?? '')
        )
            throw error
        // FAT and some network filesystems do not support hard links. Exclusive copy still
        // refuses to overwrite an intervening save; the captured original remains recoverable.
        await fs.copyFile(temporary, target, constants.COPYFILE_EXCL)
    }
}

/** Never overwrite an intervening save: retain it first, then install with exclusive creation. */
export async function installRemote(
    root: string,
    relative: string,
    content: Buffer,
    base: string | undefined,
    maxBytes: number
): Promise<boolean> {
    const remoteSha = blobSha(content)
    const target = await safePath(root, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await safePath(root, relative)
    const temporary = `${target}.${randomUUID()}.tmp`
    const backups: string[] = []
    let installed = false
    let conflict = false
    try {
        await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 })
        for (let attempt = 0; attempt < 4; attempt++) {
            const backup = await moveAside(root, relative)
            if (backup) backups.push(backup)
            try {
                await publish(temporary, await safePath(root, relative))
                installed = true
                break
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
            }
        }
        if (!installed) throw new Error('同步期间文件持续变化；已保留副本，请稍后重试。')
        for (const backup of backups) {
            const content = await readLocal(root, backup, maxBytes)
            const sha = content === undefined ? undefined : blobSha(content)
            if (sha === base || sha === remoteSha) await fs.rm(await safePath(root, backup), { force: true })
            else conflict = true
        }
        return conflict
    } catch (error) {
        if (!installed && backups.length) {
            // If publication failed, restore the last captured version when its path is still free.
            // All captured copies remain available even when restoration itself fails.
            await restoreIfMissing(root, relative, backups[backups.length - 1]).catch(() => undefined)
        }
        throw error
    } finally {
        await fs.rm(temporary, { force: true })
    }
}

/** Delete only the captured unchanged version; a late local edit is put back intact. */
export async function removeRemote(
    root: string,
    relative: string,
    expected: string,
    maxBytes: number
): Promise<{ deleted: boolean; conflict: boolean }> {
    const backup = await moveAside(root, relative)
    if (!backup) return { deleted: false, conflict: false }
    try {
        const content = await readLocal(root, backup, maxBytes)
        if (content && blobSha(content) === expected) {
            await fs.unlink(await safePath(root, backup))
            return { deleted: true, conflict: false }
        }
        const restored = await restoreIfMissing(root, relative, backup)
        if (restored) await fs.unlink(await safePath(root, backup))
        return { deleted: false, conflict: !restored }
    } catch (error) {
        await restoreIfMissing(root, relative, backup).catch(() => undefined)
        throw error
    }
}
