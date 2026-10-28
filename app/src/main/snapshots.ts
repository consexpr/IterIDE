import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CodeSnapshot, SnapshotContent } from '../shared/snapshots'
import { atomicWrite } from './problem/atomic'
import { withSourceStorage } from './problem/store'

const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)
const indexFile = (directory: string): string => path.join(directory, 'snapshots', 'index.json')
const codeFile = (directory: string, id: string): string => path.join(directory, 'snapshots', `${id}.cpp`)

function nameOf(name: string): string {
    const clean = name.trim()
    if (clean.length > 80 || /[\r\n\0]/.test(clean)) throw new Error('名称不能超过 80 个字符或换行')
    return clean
}

async function readIndex(directory: string): Promise<CodeSnapshot[]> {
    let text: string
    try {
        text = await fs.readFile(indexFile(directory), 'utf8')
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
    }
    // Never silently replace a damaged history with an empty one.
    const index = JSON.parse(text)
    if (![1, 2].includes(index?.version) || !Array.isArray(index.entries)) throw new Error('快照索引损坏，原文件已保留')
    const seen = new Set<string>()
    for (const entry of index.entries) {
        if (
            !entry ||
            !validId(entry.id) ||
            seen.has(entry.id) ||
            typeof entry.name !== 'string' ||
            !Number.isSafeInteger(entry.createdAt) ||
            entry.createdAt < 0 ||
            !Number.isSafeInteger(entry.bytes) ||
            entry.bytes < 0 ||
            !Number.isSafeInteger(entry.lines) ||
            entry.lines < 1
        )
            throw new Error('快照索引损坏，原文件已保留')
        seen.add(entry.id)
        // Older default labels carry no information; unnamed entries are identified by their time.
        if (index.version === 1 && (entry.name === '手动快照' || entry.name === '快照')) entry.name = ''
    }
    return index.entries
}

const writeIndex = (directory: string, entries: CodeSnapshot[]): Promise<void> =>
    atomicWrite(indexFile(directory), JSON.stringify({ version: 2, entries }))

function find(entries: CodeSnapshot[], id: string): CodeSnapshot {
    const entry = validId(id) && entries.find((item) => item.id === id)
    if (!entry) throw new Error('这个程序中没有该快照，请刷新列表')
    return entry
}

export function listSnapshots(sourcePath: string): Promise<CodeSnapshot[]> {
    return withSourceStorage(sourcePath, readIndex)
}

export async function createSnapshot(sourcePath: string, code: string, name = ''): Promise<CodeSnapshot> {
    const cleanName = nameOf(name)
    return withSourceStorage(sourcePath, async (directory) => {
        const entries = await readIndex(directory)
        let lines = 1
        for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) lines++
        const entry: CodeSnapshot = {
            id: randomUUID(),
            name: cleanName,
            createdAt: Date.now(),
            bytes: Buffer.byteLength(code),
            lines
        }
        await atomicWrite(codeFile(directory, entry.id), code)
        try {
            await writeIndex(directory, [entry, ...entries])
        } catch (error) {
            await fs.rm(codeFile(directory, entry.id), { force: true }).catch(() => {})
            throw error
        }
        return entry
    })
}

export function readSnapshot(sourcePath: string, id: string): Promise<SnapshotContent> {
    return withSourceStorage(sourcePath, async (directory) => {
        const entry = find(await readIndex(directory), id)
        return { ...entry, code: await fs.readFile(codeFile(directory, entry.id), 'utf8') }
    })
}

export async function renameSnapshot(sourcePath: string, id: string, name: string): Promise<void> {
    const cleanName = nameOf(name)
    return withSourceStorage(sourcePath, async (directory) => {
        const entries = await readIndex(directory)
        find(entries, id).name = cleanName
        await writeIndex(directory, entries)
    })
}

export function deleteSnapshot(sourcePath: string, id: string): Promise<void> {
    return withSourceStorage(sourcePath, async (directory) => {
        const entries = await readIndex(directory)
        find(entries, id)
        // The published index is authoritative; a failed cleanup cannot resurrect a deleted entry.
        await writeIndex(
            directory,
            entries.filter((entry) => entry.id !== id)
        )
        await fs.rm(codeFile(directory, id), { force: true }).catch(() => {})
    })
}
