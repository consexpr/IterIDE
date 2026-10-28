import { app } from 'electron'
import type { SyncResult } from '../../shared/sync'
import type { SettingsStore } from '../settings'
import { configPath, limits } from '../configBundle/common'
import { readLocal } from '../configBundle/files'
import { settingsContent } from '../configBundle/collect'
import { isBlocked, scan } from './files'
import { installRemote, removeRemote } from './apply'
import { installSettings } from './settings'
import { blobSha, GitHubClient, parallel, type RemoteFile, type TreeChange } from './github'
import { loadBaseline, saveBaseline } from './storage'

export interface CycleOptions {
    settings: SettingsStore
    repo: string
    login: string
    maxBytes: number
    client: GitHubClient
    signal: AbortSignal
    progress: (message: string) => void
}

/** Per-file three-way merge. Baselines advance only after both the ref and disk writes succeed. */
export async function syncCycle(options: CycleOptions): Promise<SyncResult> {
    const { settings, repo, login, client, signal, progress } = options
    const root = app.getPath('userData')
    const maxBytes = Math.min(options.maxBytes, limits.file)
    const result: SyncResult = { uploaded: 0, downloaded: 0, conflicts: [], skipped: [] }
    const check = (): void => {
        if (signal.aborted) throw new Error('同步已取消。')
    }
    progress('读取本地文件与远端文件树…')
    const baseline = loadBaseline(repo)
    const [localScan, remoteScan] = await Promise.allSettled([
        scan(settings, maxBytes, result.skipped),
        client.readTree(repo, login)
    ])
    if (localScan.status === 'rejected') throw localScan.reason
    if (remoteScan.status === 'rejected') throw remoteScan.reason
    const local = localScan.value
    const remote = remoteScan.value
    check()
    const changes: TreeChange[] = []
    const uploads: { path: string; sha: string }[] = []
    const downloads: { path: string; file: RemoteFile }[] = []
    const removals: string[] = []
    // Drop legacy store paths from bookkeeping without touching their local or remote contents.
    const next = Object.fromEntries(Object.entries(baseline.blobs).filter(([name]) => configPath(name)))
    const paths = new Set([...Object.keys(baseline.blobs), ...local.files.keys(), ...remote.files.keys()])
    const casePaths = new Map<string, string>()
    const caseBlocked = new Set<string>()
    if (process.platform === 'win32') {
        for (const name of paths) {
            if (!configPath(name)) continue
            const key = name.toLowerCase()
            const old = casePaths.get(key)
            if (old && old !== name) {
                caseBlocked.add(old)
                caseBlocked.add(name)
            }
            casePaths.set(key, name)
        }
    }
    for (const name of paths) {
        const l = local.files.get(name)
        const r = remote.files.get(name)
        if (!configPath(name) || isBlocked(name, local.blocked) || caseBlocked.has(name)) {
            if (r && !result.skipped.some((item) => item.path === name))
                result.skipped.push({
                    path: name,
                    reason: '非配置文件、备份、临时文件、不安全路径、符号链接或路径大小写冲突不参与同步。'
                })
            continue
        }
        if (r && r.size > (name === 'settings.json' ? Math.min(maxBytes, limits.settings) : maxBytes)) {
            result.skipped.push({ path: name, reason: `远端文件超过同步大小上限（${maxBytes} 字节）或类型不受支持。` })
            continue
        }
        const b = baseline.blobs[name]
        // SettingsStore always has defaults; deleting settings remotely must not erase live settings.
        if (name === 'settings.json' && !r && l) {
            uploads.push({ path: name, sha: l.sha })
            next[name] = l.sha
            continue
        }
        if (l?.sha === r?.sha) {
            if (r) next[name] = r.sha
            else delete next[name]
            continue
        }
        if (r) next[name] = r.sha
        else delete next[name]
        if (l?.sha === b) {
            if (r) downloads.push({ path: name, file: r })
            else removals.push(name)
        } else if (r?.sha === b) {
            if (l) {
                uploads.push({ path: name, sha: l.sha })
                next[name] = l.sha
            } else {
                changes.push({ path: name, mode: '100644', type: 'blob', sha: null })
                delete next[name]
            }
        } else if (!r && l) {
            // Delete vs edit: keep and re-upload the edited local file.
            uploads.push({ path: name, sha: l.sha })
            next[name] = l.sha
        } else if (r) {
            // Both edits: preserve current local contents just before installing the remote.
            downloads.push({ path: name, file: r })
        }
    }
    progress(`上传 ${uploads.length} 个文件，下载 ${downloads.length} 个文件…`)
    await parallel(uploads, async (item) => {
        check()
        const content =
            item.path === 'settings.json' ? settingsContent(settings) : await readLocal(root, item.path, maxBytes)
        if (!content || blobSha(content) !== item.sha) throw new Error('同步期间本地文件发生变化，请重试。')
        const sha = await client.upload(repo, content)
        changes.push({ path: item.path, mode: '100644', type: 'blob', sha })
    })
    check()
    const commit = await client.commit(repo, remote, changes)
    check()
    result.uploaded = changes.length
    // Wait for all started workers on failure; keep the old baseline for a conservative retry.
    await parallel(downloads, async (item) => {
        const content = await client.download(
            repo,
            item.file,
            item.path === 'settings.json' ? Math.min(maxBytes, limits.settings) : maxBytes
        )
        check()
        const conflict =
            item.path === 'settings.json'
                ? await installSettings(root, settings, content, baseline.blobs[item.path])
                : await installRemote(root, item.path, content, baseline.blobs[item.path], maxBytes)
        if (conflict) result.conflicts.push(item.path)
        result.downloaded++
    })
    for (const name of removals) {
        check()
        const removed = await removeRemote(root, name, local.files.get(name)!.sha, maxBytes)
        if (removed.deleted) result.downloaded++
        if (removed.conflict) result.conflicts.push(name)
    }
    check()
    saveBaseline(repo, { commit, blobs: next, lastSync: Date.now() })
    return result
}
