import {
    cpSync,
    existsSync,
    lstatSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { atomicJsonSync } from './atomic'
import { storeRoot } from './root'
import { LEGACY_IDENTITY_NAME, LEGACY_STORE_NAME, relocatedLegacyPath } from '../legacyStorage'

export interface ProblemMeta {
    id: string
    sourcePath: string
    title: string
    createdAt: number
    updatedAt: number
}
export interface Binding {
    id: string
    dir: string
}
export type ProblemIndex = Record<string, string>

export function validId(id: unknown): id is string {
    return typeof id === 'string' && /^[\w-]{1,128}$/.test(id)
}
export function absolutePath(file: string): boolean {
    return path.isAbsolute(file) || path.win32.isAbsolute(file) || path.posix.isAbsolute(file)
}
export function pathKey(file: string): string {
    const absolute = path.resolve(file)
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}
export function directoryForId(id: string): string {
    if (!validId(id)) throw new Error('无效的题目 ID')
    return path.join(storeRoot(), 'problems', id)
}
export function legacyProblemDir(src: string): string {
    const parent = path.dirname(path.resolve(src)),
        name = path.parse(src).name
    const current = path.join(parent, '.iter', name)
    const previous = path.join(parent, LEGACY_STORE_NAME, name)
    return existsSync(current) || !existsSync(previous) ? current : previous
}
export function readIndex(): ProblemIndex {
    let raw: unknown
    try {
        raw = JSON.parse(readFileSync(path.join(storeRoot(), 'index.json'), 'utf8').replace(/^\uFEFF/, ''))
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.create(null) as ProblemIndex
        throw new Error('无法读取题目索引 index.json，请检查文件内容及访问权限', { cause: error })
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('题目索引 index.json 格式无效')
    const index = Object.create(null) as ProblemIndex
    for (const [id, file] of Object.entries(raw)) {
        if (validId(id) && typeof file === 'string' && absolutePath(file) && !file.includes('\0'))
            index[id] = relocatedLegacyPath(file)
    }
    return index
}
export function writeIndex(index: ProblemIndex): void {
    atomicJsonSync(path.join(storeRoot(), 'index.json'), index)
}

const unavailableTools = new Set<string>()
function xattr(command: string, args: string[]): string | undefined {
    if (unavailableTools.has(command)) return undefined
    try {
        return execFileSync(command, args, {
            encoding: 'utf8',
            timeout: 1000,
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true
        }).trim()
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') unavailableTools.add(command)
        return undefined
    }
}

/** Unsupported volumes/tools are deliberately silent; the exact-path index is authoritative there. */
function readNamedIdentity(src: string, name: string): string | undefined {
    try {
        const value =
            process.platform === 'win32'
                ? readFileSync(`${src}:${name}`, 'utf8').trim()
                : process.platform === 'darwin'
                  ? xattr('xattr', ['-p', `user.${name}`, src])
                  : process.platform === 'linux'
                    ? xattr('getfattr', ['--only-values', '-n', `user.${name}`, '--', src])
                    : undefined
        return validId(value) ? value : undefined
    } catch {
        return undefined
    }
}
export function readIdentity(src: string): string | undefined {
    return readNamedIdentity(src, 'iter.id') ?? readNamedIdentity(src, LEGACY_IDENTITY_NAME)
}
export function writeIdentity(src: string, id: string): boolean {
    try {
        const before = statSync(src)
        if (!before.isFile()) return false
        if (readNamedIdentity(src, 'iter.id') === id) return true
        let written = true
        if (process.platform === 'win32') writeFileSync(`${src}:iter.id`, id, 'utf8')
        else if (process.platform === 'darwin') written = xattr('xattr', ['-w', 'user.iter.id', id, src]) !== undefined
        else if (process.platform === 'linux')
            written = xattr('setfattr', ['-n', 'user.iter.id', '-v', id, '--', src]) !== undefined
        else written = false
        // An ADS write may update LastWriteTime on some volumes. Keep the main file's visible timestamp.
        const after = statSync(src)
        if (after.mtimeMs !== before.mtimeMs) utimesSync(src, before.atime, before.mtime)
        return written
    } catch {
        return false /* FAT, network shares, permissions: retain path-only binding. */
    }
}

// A copied stream can be readable but not writable (for example a read-only share).
// Remember observed write failures so repeated lookups do not create a fresh clone every time.
const pathOnlyBindings = new Map<string, { id: string; stream?: string }>()
const fallbackKey = (src: string): string => `${pathKey(storeRoot())}\0${pathKey(src)}`
function assertIdentity(src: string, id: string): void {
    if (writeIdentity(src, id)) pathOnlyBindings.delete(fallbackKey(src))
    else pathOnlyBindings.set(fallbackKey(src), { id, stream: readIdentity(src) })
}

/** No await between reading and replacing index.json, including copy detection. */
export function resolveIdentity(sourcePath: string): Binding {
    const src = path.resolve(sourcePath),
        index = readIndex(),
        key = pathKey(src)
    const stream = readIdentity(src)
    const fallback = pathOnlyBindings.get(fallbackKey(src))
    let id: string | undefined =
        fallback && fallback.stream === stream && index[fallback.id] && pathKey(index[fallback.id]) === key
            ? fallback.id
            : undefined
    let copyFrom: string | undefined
    if (!id && stream) {
        const oldPath = index[stream]
        if (oldPath && (pathKey(oldPath) === key || !existsSync(oldPath))) id = stream
        else if (oldPath)
            copyFrom = stream // Never steal an identity from an occupied path.
        else if (existsSync(directoryForId(stream))) id = stream // Store restored by sync, index not rebuilt yet.
    }
    if (!id && !copyFrom) id = Object.keys(index).find((candidate) => pathKey(index[candidate]) === key)
    id ??= randomUUID()
    const dir = directoryForId(id)
    if (copyFrom && existsSync(directoryForId(copyFrom))) {
        // Publish a complete clone, never an index pointing at a half-copied dataset.
        const temporary = `${dir}.copy-${randomUUID()}`
        try {
            cpSync(directoryForId(copyFrom), temporary, {
                recursive: true,
                errorOnExist: true,
                force: false,
                filter: (file) => !lstatSync(file).isSymbolicLink()
            })
            renameSync(temporary, dir)
        } finally {
            if (
                path.dirname(temporary) === path.join(storeRoot(), 'problems') &&
                path.basename(temporary).startsWith(`${id}.copy-`)
            )
                rmSync(temporary, { recursive: true, force: true })
        }
    }
    if (index[id] !== src) {
        index[id] = src
        writeIndex(index)
    }
    assertIdentity(src, id)
    return { id, dir }
}

/** Import previews must remain read-only, including when only a legacy sidecar exists. */
export function existingProblemDir(sourcePath: string): string {
    const src = path.resolve(sourcePath),
        index = readIndex(),
        stream = readIdentity(src)
    const id =
        stream && (!index[stream] || pathKey(index[stream]) === pathKey(src) || !existsSync(index[stream]))
            ? stream
            : Object.keys(index).find((candidate) => pathKey(index[candidate]) === pathKey(src))
    return id && existsSync(path.join(directoryForId(id), 'problem.json')) ? directoryForId(id) : legacyProblemDir(src)
}

export function readMeta(dir: string): ProblemMeta | undefined {
    try {
        const value = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')) as Partial<ProblemMeta> | null
        if (
            !value ||
            !validId(value.id) ||
            typeof value.sourcePath !== 'string' ||
            !absolutePath(value.sourcePath) ||
            typeof value.title !== 'string' ||
            typeof value.createdAt !== 'number' ||
            !Number.isFinite(value.createdAt) ||
            typeof value.updatedAt !== 'number' ||
            !Number.isFinite(value.updatedAt)
        )
            return undefined
        return { ...value, sourcePath: relocatedLegacyPath(value.sourcePath) } as ProblemMeta
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined
        throw error
    }
}

export function bindIdentity(src: string, id: string): void {
    const index = readIndex(),
        key = pathKey(src)
    let changed = index[id] !== path.resolve(src)
    for (const candidate of Object.keys(index))
        if (candidate !== id && pathKey(index[candidate]) === key) {
            delete index[candidate]
            changed = true
        }
    index[id] = path.resolve(src)
    if (changed) writeIndex(index)
    assertIdentity(path.resolve(src), id)
}
