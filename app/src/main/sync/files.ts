import type { SyncResult } from '../../shared/sync'
import type { SettingsStore } from '../settings'
import { collectConfig } from '../configBundle/collect'
import { blobSha } from './github'

export interface LocalFile {
    sha: string
    size: number
}
export interface LocalSnapshot {
    files: Map<string, LocalFile>
    blocked: Set<string>
}

export function isBlocked(file: string, blocked: Set<string>): boolean {
    const parts = file.split('/')
    return parts.some((_, index) => blocked.has(parts.slice(0, index + 1).join('/')))
}

export async function scan(
    settings: SettingsStore,
    maxBytes: number,
    skipped: SyncResult['skipped']
): Promise<LocalSnapshot> {
    const files = new Map<string, LocalFile>()
    const blocked = new Set<string>()
    for await (const entry of collectConfig(settings, {
        maxBytes,
        skip: (name, reason) => {
            blocked.add(name)
            skipped.push({ path: name, reason })
        }
    })) {
        if (!entry.name.endsWith('/')) files.set(entry.name, { sha: blobSha(entry.data), size: entry.data.length })
    }
    return { files, blocked }
}
