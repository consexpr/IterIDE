import {
    constants,
    promises as fs,
    closeSync,
    fsyncSync,
    mkdirSync,
    openSync,
    renameSync,
    rmSync,
    writeFileSync
} from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export async function atomicWrite(
    file: string,
    content: string | Buffer,
    beforeReplace?: (temporary: string) => Promise<void>
): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
        const handle = await fs.open(temporary, 'wx')
        try {
            await handle.writeFile(content)
            await handle.sync()
        } finally {
            await handle.close()
        }
        await beforeReplace?.(temporary)
        await replace(temporary, file)
    } finally {
        await fs.rm(temporary, { force: true }).catch(() => {})
    }
}

/** Publish a completed staged file without overwriting an existing file, including on Windows. */
export async function publishExclusive(source: string, target: string): Promise<void> {
    await fs.mkdir(path.dirname(target), { recursive: true })
    try {
        await fs.link(source, target)
    } catch (error) {
        if (
            !['EPERM', 'EOPNOTSUPP', 'ENOSYS', 'ENOTSUP', 'EXDEV'].includes((error as NodeJS.ErrnoException).code ?? '')
        )
            throw error
        await fs.copyFile(source, target, constants.COPYFILE_EXCL)
        const handle = await fs.open(target, 'r+')
        try {
            await handle.sync()
        } finally {
            await handle.close()
        }
    }
}

async function replace(temporary: string, file: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        try {
            await fs.rename(temporary, file)
            return
        } catch (error) {
            if (
                process.platform !== 'win32' ||
                !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') ||
                attempt >= 10
            )
                throw error
            await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)))
        }
    }
}

/** Keep imported datasets bounded in memory even when they contain multi-gigabyte files. */
export async function atomicCopy(source: string, target: string): Promise<void> {
    await fs.mkdir(path.dirname(target), { recursive: true })
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
        await fs.copyFile(source, temporary)
        const handle = await fs.open(temporary, 'r+')
        try {
            await handle.sync()
        } finally {
            await handle.close()
        }
        await replace(temporary, target)
    } finally {
        await fs.rm(temporary, { force: true }).catch(() => {})
    }
}

/** Publish problem.json last so an interrupted legacy migration can be retried safely. */
export async function copyDirectory(source: string, target: string): Promise<void> {
    await fs.mkdir(target, { recursive: true })
    const entries = await fs.readdir(source, { withFileTypes: true })
    entries.sort((a, b) => Number(a.name === 'problem.json') - Number(b.name === 'problem.json'))
    for (const entry of entries) {
        const from = path.join(source, entry.name),
            to = path.join(target, entry.name)
        if (entry.isDirectory()) await copyDirectory(from, to)
        else if (entry.isFile()) await atomicCopy(from, to)
    }
}

/** Index updates cannot yield: problemDir() is a long-standing synchronous public API. */
export function atomicJsonSync(file: string, value: unknown): void {
    mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
        const handle = openSync(temporary, 'wx')
        try {
            writeFileSync(handle, JSON.stringify(value, null, 2) + '\n')
            fsyncSync(handle)
        } finally {
            closeSync(handle)
        }
        for (let attempt = 0; ; attempt++) {
            try {
                renameSync(temporary, file)
                break
            } catch (error) {
                if (
                    process.platform !== 'win32' ||
                    !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') ||
                    attempt >= 10
                )
                    throw error
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 * (attempt + 1))
            }
        }
    } finally {
        rmSync(temporary, { force: true })
    }
}
