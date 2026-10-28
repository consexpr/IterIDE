import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, lstat, open, opendir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { crc32 } from 'node:zlib'
import { diskResources, type ResourceSource } from '../problem/resources'
import * as yauzl from 'yauzl'
import { ignoredEntry, relativeEntry } from './pairing'

export interface ImportSource {
    paths: string[]
    notes: string[]
    archive: boolean
    assertFile(path: string): Promise<void>
    readText(path: string): Promise<string>
    /** Preserve bytes and bound memory; ZIP content is checked before this promise resolves. */
    copyEntry(path: string, target: string): Promise<void>
    /** Archives stream a single attachment to a private temporary directory. */
    attachment(path: string, temporaryDirectory: string): Promise<string>
    close(): void
}

// Generous disk budgets preserve multi-GiB datasets without permitting unbounded extraction.
export const importLimits = { entries: 100_000, file: 16 * 1024 ** 3, total: 64 * 1024 ** 3 }
const TEXT_LIMIT = 16 * 1024 * 1024

/** Source analysis must not load an arbitrarily large local file into the main process. */
export async function readImportText(file: string): Promise<string> {
    if ((await stat(file)).size > TEXT_LIMIT) throw new Error('文本预览超过 16 MiB；请使用流式导入')
    const chunks: Buffer[] = []
    let size = 0
    const stream = createReadStream(file)
    for await (const chunk of stream) {
        size += chunk.length
        // Also enforce the budget while reading: a producer can grow the file after stat().
        if (size > TEXT_LIMIT) throw new Error('文本预览超过 16 MiB；请使用流式导入')
        chunks.push(chunk)
    }
    return Buffer.concat(chunks, size).toString('utf8')
}

async function copyStream(
    stream: NodeJS.ReadableStream,
    target: string,
    expected?: { size: number; crc: number },
    account: (size: number) => void = () => {}
): Promise<void> {
    let size = 0,
        checksum = 0
    const checked = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length
            if (size > importLimits.file || (expected && size > expected.size)) {
                callback(new Error('导入文件超过大小上限或 ZIP 长度校验失败'))
                return
            }
            try {
                account(chunk.length)
                checksum = crc32(chunk, checksum)
                callback(null, chunk)
            } catch (error) {
                callback(error as Error)
            }
        }
    })
    await pipeline(stream, checked, createWriteStream(target, { flags: 'wx' }))
    if (expected && (size !== expected.size || checksum !== expected.crc)) throw new Error('ZIP CRC 或长度校验失败')
    const handle = await open(target, 'r+')
    try {
        await handle.sync()
    } finally {
        await handle.close()
    }
}

function entryPath(path: string): string {
    const normalized = relativeEntry(path)
    if (!normalized || ignoredEntry(normalized)) throw new Error(`Invalid import entry: ${path}`)
    return normalized
}

function within(root: string, file: string): boolean {
    const rel = relative(root, file)
    return rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel)
}

async function folderSource(root: string, listDirectory: boolean): Promise<ImportSource> {
    const canonicalRoot = await realpath(root)
    const paths: string[] = []
    const notes: string[] = []
    let copied = 0
    const account = (size: number): void => {
        if ((copied += size) > importLimits.total) throw new Error('导入数据总量超过上限')
    }
    const pending = listDirectory ? [''] : []
    let visited = 0
    while (pending.length) {
        const directory = pending.pop()!
        const entries = await opendir(join(root, directory))
        for await (const entry of entries) {
            const path = directory ? `${directory}/${entry.name}` : entry.name
            if (ignoredEntry(path)) continue
            if (++visited > importLimits.entries) throw new Error('目录文件数量超过导入上限')
            // Don't follow links outside the dataset or recurse through cycles.
            if (entry.isSymbolicLink()) {
                notes.push(`已跳过符号链接 ${path}`)
                continue
            }
            if (!relativeEntry(path)) {
                notes.push(`已忽略不安全路径 ${path}`)
                continue
            }
            if (entry.isDirectory()) pending.push(path)
            else if (entry.isFile()) paths.push(path)
        }
    }
    const filePath = async (path: string): Promise<string> => {
        const file = resolve(root, entryPath(path))
        if (!within(root, file) || !(await lstat(file)).isFile() || !within(canonicalRoot, await realpath(file))) {
            throw new Error(`Import entry is not a regular file inside the source: ${path}`)
        }
        return file
    }
    return {
        paths,
        notes,
        archive: false,
        async assertFile(path) {
            await filePath(path)
        },
        async readText(path) {
            return readImportText(await filePath(path))
        },
        async copyEntry(path, target) {
            const source = await filePath(path)
            await copyStream(createReadStream(source), target, undefined, account)
            if (process.platform !== 'win32') await chmod(target, (await stat(source)).mode & 0o777)
        },
        async attachment(path) {
            return filePath(path)
        },
        close() {}
    }
}

function zipName(entry: yauzl.Entry): { name: string; legacy: boolean } {
    const bytes = entry.fileNameRaw
    if (entry.generalPurposeBitFlag & 0x800) return { name: bytes.toString('utf8'), legacy: false }
    const unicode = entry.extraFields.find(
        (field) =>
            field.id === 0x7075 &&
            field.data.length >= 5 &&
            field.data[0] === 1 &&
            field.data.readUInt32LE(1) === crc32(bytes)
    )
    if (unicode) return { name: unicode.data.subarray(5).toString('utf8'), legacy: false }
    try {
        return { name: new TextDecoder('utf-8', { fatal: true }).decode(bytes), legacy: false }
    } catch {
        try {
            return { name: new TextDecoder('gb18030', { fatal: true }).decode(bytes), legacy: true }
        } catch {
            return {
                name: yauzl.getFileNameLowLevel(entry.generalPurposeBitFlag, bytes, entry.extraFields, false),
                legacy: true
            }
        }
    }
}

async function archiveSource(path: string): Promise<ImportSource> {
    const zip = await yauzl.openPromise(path, { autoClose: false, decodeStrings: false, validateEntrySizes: true })
    const entries = new Map<string, yauzl.Entry>()
    const notes: string[] = []
    // Keep a listener throughout the source lifetime, including attachment streams.
    let archiveError: Error | undefined
    zip.on('error', (error: Error) => {
        archiveError = error
    })
    let legacy = false
    let advertised = 0,
        copied = 0
    const account = (size: number): void => {
        if ((copied += size) > importLimits.total) throw new Error('导入数据总量超过上限')
    }
    try {
        if (zip.entryCount > importLimits.entries) throw new Error('ZIP 文件数量超过导入上限')
        for await (const entry of zip.eachEntry()) {
            const decoded = zipName(entry)
            legacy ||= decoded.legacy
            const mode = (entry.externalFileAttributes >>> 16) & 0o170000
            if (/[\\/]$/.test(decoded.name) || mode === 0o040000) continue
            const name = relativeEntry(decoded.name)
            if (!name) {
                notes.push(`已忽略压缩包不安全路径 ${decoded.name}`)
                continue
            }
            if (ignoredEntry(name)) continue
            if (mode === 0o120000 || !entry.canDecodeFileData()) {
                const reason = mode === 0o120000 ? '符号链接' : entry.isEncrypted() ? '加密文件' : '不支持的压缩格式'
                notes.push(`已跳过${reason} ${name}`)
                continue
            }
            if (entries.has(name)) {
                notes.push(`${name} 重复，已采用首个文件`)
                continue
            }
            if (
                entry.uncompressedSize > importLimits.file ||
                (advertised += entry.uncompressedSize) > importLimits.total
            )
                throw new Error('ZIP 解压数据超过导入大小上限')
            entries.set(name, entry)
        }
        if (legacy) notes.push('旧编码文件名已按 GB18030/CP437 尝试解码')
    } catch (error) {
        zip.close()
        throw error
    }
    const getEntry = (path: string): yauzl.Entry => {
        if (archiveError) throw archiveError
        const entry = entries.get(entryPath(path))
        if (!entry) throw new Error(`ZIP entry not found: ${path}`)
        return entry
    }
    return {
        paths: [...entries.keys()],
        notes,
        archive: true,
        async assertFile(path) {
            getEntry(path)
        },
        async readText(path) {
            const entry = getEntry(path),
                stream = await zip.openReadStreamPromise(entry)
            const chunks: Buffer[] = []
            let size = 0,
                checksum = 0
            for await (const chunk of stream) {
                size += chunk.length
                if (size > TEXT_LIMIT) {
                    stream.destroy()
                    throw new Error('文本预览超过 16 MiB；请使用流式导入')
                }
                checksum = crc32(chunk, checksum)
                chunks.push(chunk)
            }
            if (size !== entry.uncompressedSize || checksum !== entry.crc32) throw new Error('ZIP CRC 或长度校验失败')
            return Buffer.concat(chunks).toString('utf8')
        },
        async copyEntry(path, target) {
            const entry = getEntry(path)
            await copyStream(
                await zip.openReadStreamPromise(entry),
                target,
                { size: entry.uncompressedSize, crc: entry.crc32 },
                account
            )
            if (process.platform !== 'win32' && (entry.externalFileAttributes >>> 16) & 0o111)
                await chmod(target, 0o755)
            if (archiveError) throw archiveError
        },
        async attachment(path, temporaryDirectory) {
            const target = join(temporaryDirectory, basename(entryPath(path)))
            const entry = getEntry(path)
            await copyStream(
                await zip.openReadStreamPromise(entry),
                target,
                { size: entry.uncompressedSize, crc: entry.crc32 },
                account
            )
            return target
        },
        close() {
            zip.close()
        }
    }
}

export async function openSource(path: string, options: { listDirectory?: boolean } = {}): Promise<ImportSource> {
    const root = resolve(path)
    const info = await stat(root)
    if (info.isDirectory()) return folderSource(root, options.listDirectory !== false)
    if (info.isFile() && /\.zip$/i.test(root)) return archiveSource(root)
    throw new Error('Import a directory or a .zip archive. Other archive formats are not supported.')
}

export function commonParent(paths: string[]): string {
    if (!paths.length) throw new Error('Select at least one file to import.')
    let parent = dirname(paths[0])
    for (const path of paths.slice(1)) {
        while (!within(parent, path)) {
            const next = dirname(parent)
            if (next === parent) throw new Error('Loose files must be on the same filesystem root.')
            parent = next
        }
    }
    return parent
}

export function importResources(source: ImportSource, root: string): ResourceSource {
    const entry = (file: string): string => {
        const result = relative(resolve(root), resolve(file)).replaceAll('\\', '/')
        if (result === '..' || result.startsWith('../') || isAbsolute(result))
            throw new Error('依赖超出导入目录：' + file)
        return result
    }
    return {
        ...(source.archive
            ? { virtual: { root: resolve(root), files: source.paths.map((file) => resolve(root, file)) } }
            : {}),
        ...(!source.archive ? { size: diskResources.size } : {}),
        exists: async (file) => {
            let name: string
            try {
                name = entry(file)
            } catch {
                return false
            }
            try {
                await source.assertFile(name)
                return true
            } catch (error) {
                if (!source.archive && !['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
                    throw error
                return false
            }
        },
        text: (file) => source.readText(entry(file)),
        copy: (file, target) => source.copyEntry(entry(file), target),
        siblings: async (file) =>
            !source.archive
                ? diskResources.siblings(file)
                : source.paths
                      .filter((name) => dirname(name) === dirname(entry(file)))
                      .map((name) => resolve(root, name))
    }
}
