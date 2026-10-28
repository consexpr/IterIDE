import { promises as fs } from 'node:fs'
import path from 'node:path'
import { sanitizeViewState, type SessionData, type SessionTab } from '../shared/session'
import { atomicWrite } from './problem/atomic'
import { isUntitledPath, untitledPath } from './untitled'
import { relocatedLegacyPath } from './legacyStorage'

const file = (dir: string): string => path.join(dir, 'session.json')
const saves = new Map<string, Promise<void>>()

/** Drop anything malformed rather than failing: a damaged session must never block startup. */
export function sanitizeSession(value: unknown): SessionData | null {
    if (!value || typeof value !== 'object') return null
    const raw = value as { tabs?: unknown; active?: unknown }
    if (!Array.isArray(raw.tabs)) return null
    const tabs: SessionTab[] = []
    const seen = new Set<string>()
    for (const item of raw.tabs) {
        const t = item as Partial<SessionTab> | null
        if (
            !t ||
            typeof t.path !== 'string' ||
            !t.path ||
            typeof t.text !== 'string' ||
            typeof t.saved !== 'string' ||
            seen.has(relocatedLegacyPath(t.path))
        )
            continue
        const tabPath = relocatedLegacyPath(t.path)
        if (
            t.untitled !== undefined &&
            (!Number.isInteger(t.untitled) || t.untitled! < 1 || path.resolve(tabPath) !== untitledPath(t.untitled!))
        )
            continue
        // A managed file name without its marker would be mistaken for an ordinary file and never cleaned up.
        if (t.untitled === undefined && isUntitledPath(tabPath)) continue
        seen.add(tabPath)
        const viewState = sanitizeViewState(t.viewState)
        tabs.push({
            path: tabPath,
            ...(t.untitled === undefined ? {} : { untitled: t.untitled }),
            ...(t.missing === true ? { missing: true } : {}),
            text: t.text,
            saved: t.saved,
            ...(viewState ? { viewState } : {})
        })
    }
    const active = typeof raw.active === 'string' ? relocatedLegacyPath(raw.active) : null
    return { version: 1, active: active && seen.has(active) ? active : null, tabs }
}

export async function loadSession(dir: string): Promise<SessionData | null> {
    try {
        const session = sanitizeSession(JSON.parse(await fs.readFile(file(dir), 'utf8')))
        if (!session) throw new Error('会话数据格式无效')
        return session
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw new Error('会话文件无法读取，请保留 session.json 后检查文件内容及权限。', { cause: error })
    }
}

export async function saveSession(dir: string, data: SessionData): Promise<void> {
    const clean = sanitizeSession(data)
    if (!clean) throw new Error('会话数据无效')
    const target = path.resolve(file(dir))
    const key = process.platform === 'win32' ? target.toLowerCase() : target
    const next = (saves.get(key) ?? Promise.resolve())
        .catch(() => {})
        .then(() => atomicWrite(target, JSON.stringify(clean)))
    saves.set(key, next)
    try {
        await next
    } finally {
        if (saves.get(key) === next) saves.delete(key)
    }
}
