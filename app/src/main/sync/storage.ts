import { app, safeStorage } from 'electron'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SyncAccount } from '../../shared/sync'

export interface Baseline {
    commit?: string
    blobs: Record<string, string>
    lastSync?: number
}
interface StateFile {
    version: 1
    repositories: Record<string, Baseline>
}
export const MEMORY_ONLY = '系统安全存储不可用，令牌仅保存在内存中；重启后请重新登录。'

function file(name: string): string {
    return path.join(app.getPath('userData'), name)
}

function atomicJson(name: string, data: unknown): void {
    const target = file(name)
    mkdirSync(path.dirname(target), { recursive: true })
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
        writeFileSync(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx' })
        renameSync(temporary, target)
    } finally {
        rmSync(temporary, { force: true })
    }
}

function encryptionAvailable(): boolean {
    return (
        safeStorage.isEncryptionAvailable() &&
        !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
    )
}

export function loadCredentials(): { token: string; account: SyncAccount } | undefined {
    try {
        if (!encryptionAvailable()) return undefined
        const stored = JSON.parse(readFileSync(file('sync-token.json'), 'utf8')) as {
            encrypted: string
            account: SyncAccount
        }
        if (
            typeof stored.encrypted !== 'string' ||
            typeof stored.account?.login !== 'string' ||
            !/^[a-zA-Z0-9-]+$/.test(stored.account.login)
        )
            return undefined
        const token = safeStorage.decryptString(Buffer.from(stored.encrypted, 'base64'))
        if (!token) return undefined
        return { token, account: stored.account }
    } catch {
        return undefined
    }
}

/** Storage failure still leaves a usable in-memory session. Never persist a plaintext fallback. */
export function saveCredentials(token: string, account: SyncAccount): string | undefined {
    try {
        if (!encryptionAvailable()) {
            deleteCredentials()
            return MEMORY_ONLY
        }
        const encrypted = safeStorage.encryptString(token).toString('base64')
        atomicJson('sync-token.json', { encrypted, account })
        return undefined
    } catch {
        // Remove an older account's credential so a restart cannot silently restore the wrong login.
        deleteCredentials()
        return MEMORY_ONLY
    }
}

export function deleteCredentials(): void {
    rmSync(file('sync-token.json'), { force: true })
}

function readState(): StateFile {
    try {
        const state = JSON.parse(readFileSync(file('sync-state.json'), 'utf8')) as StateFile
        if (state.version === 1 && state.repositories && typeof state.repositories === 'object') return state
    } catch {
        /* A lost baseline conservatively preserves divergent contents as conflicts. */
    }
    return { version: 1, repositories: {} }
}

export function loadBaseline(repo: string): Baseline {
    const value = readState().repositories[repo.toLowerCase()]
    if (!value || !value.blobs || typeof value.blobs !== 'object') return { blobs: {} }
    return {
        commit: typeof value.commit === 'string' ? value.commit : undefined,
        lastSync: typeof value.lastSync === 'number' ? value.lastSync : undefined,
        blobs: Object.fromEntries(
            Object.entries(value.blobs).filter(([, sha]) => typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha))
        )
    }
}

export function saveBaseline(repo: string, baseline: Baseline): void {
    const state = readState()
    state.repositories[repo.toLowerCase()] = baseline
    atomicJson('sync-state.json', state)
}
