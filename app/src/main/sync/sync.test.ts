import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    unlinkSync,
    writeFileSync
} from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../../shared/settings'
import { BUILTIN_GITHUB_CLIENT_ID, type SyncSettings, type SyncState } from '../../shared/sync'
import { SettingsStore } from '../settings'

const runtime = vi.hoisted(() => ({
    userData: '',
    encryption: true,
    quit: [] as (() => void)[],
    open: vi.fn(async (_uri: string) => {})
}))
vi.mock('electron', () => ({
    app: {
        getPath: () => runtime.userData,
        getAppPath: () => runtime.userData,
        once: (_event: string, callback: () => void) => {
            runtime.quit.push(callback)
        }
    },
    shell: { openExternal: runtime.open },
    safeStorage: {
        isEncryptionAvailable: () => runtime.encryption,
        getSelectedStorageBackend: () => 'test-secret-store',
        encryptString: (value: string) => Buffer.from([...Buffer.from(value)].map((byte) => byte ^ 0x61)),
        decryptString: (value: Buffer) => Buffer.from([...value].map((byte) => byte ^ 0x61)).toString()
    }
}))

import { SyncManager } from './index'
import { blobSha } from './github'
import { collectConfig, settingsContent } from '../configBundle/collect'
import { loadBaseline, saveBaseline } from './storage'
import { FAKE_TOKEN, FakeGitHub, json } from './test-github'

let temporary: string
let root: string
let github: FakeGitHub
let store: SettingsStore
let settings: SyncSettings
let managers: SyncManager[]
let states: SyncState[]

function manager(): SyncManager {
    const instance = new SyncManager(store, (state) => states.push(state), github)
    managers.push(instance)
    return instance
}

async function signedIn(): Promise<SyncManager> {
    const instance = manager()
    await instance.loginToken(FAKE_TOKEN)
    return instance
}

function local(name: string, content: string | Buffer): void {
    const target = path.join(root, name)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content)
}

function text(name: string): string {
    return readFileSync(path.join(root, name), 'utf8')
}
function posts(suffix: string): number {
    return github.requests.filter((item) => item.method === 'POST' && item.route.endsWith(suffix)).length
}

beforeEach(() => {
    temporary = mkdtempSync(path.join(os.tmpdir(), 'iter-sync-test-'))
    root = runtime.userData = path.join(temporary, 'userData')
    mkdirSync(root)
    store = new SettingsStore()
    runtime.encryption = true
    runtime.quit = []
    managers = []
    states = []
    settings = store.set({ sync: { ...defaultSettings().sync, intervalMin: 0 } }).sync
    github = new FakeGitHub()
    vi.stubEnv('ITER_STORE', path.join(temporary, 'store'))
    vi.stubGlobal('fetch', vi.fn(github.fetch))
})

afterEach(async () => {
    runtime.quit.forEach((callback) => callback())
    await Promise.allSettled(managers.map((instance) => instance.logout()))
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    runtime.open.mockClear()
    const resolved = path.resolve(temporary)
    if (
        !resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
        !path.basename(resolved).startsWith('iter-sync-test-')
    ) {
        throw new Error('Unsafe test cleanup path')
    }
    rmSync(resolved, { recursive: true, force: true })
})

describe('GitHub authentication', () => {
    it('preserves an existing default remote after the rename while honoring explicit repositories', async () => {
        saveBaseline('tester/naven-sync', { commit: 'a'.repeat(40), blobs: {}, lastSync: Date.now() })
        const instance = await signedIn()
        expect(await instance.state()).toMatchObject({ repo: 'tester/naven-sync' })
        store.set({ sync: { ...settings, repo: 'tester/chosen' } })
        expect(await instance.state()).toMatchObject({ repo: 'tester/chosen' })
    })

    it('validates a token, encrypts it outside the store, restores it, and deletes it on logout', async () => {
        const instance = await signedIn()
        expect(github.requests[0].route).toBe('/user')
        expect(await instance.state()).toMatchObject({
            status: 'idle',
            account: { login: 'tester' },
            repo: 'tester/iter-sync'
        })
        const credential = path.join(runtime.userData, 'sync-token.json')
        expect(readFileSync(credential, 'utf8')).not.toContain(FAKE_TOKEN)
        expect(existsSync(path.join(temporary, 'store/sync-token.json'))).toBe(false)
        const restored = manager()
        expect(await restored.state()).toMatchObject({ status: 'idle', account: { login: 'tester' } })
        await restored.logout()
        expect(existsSync(credential)).toBe(false)
        expect(await restored.state()).toEqual({ status: 'signed-out' })
        expect(await manager().state()).toEqual({ status: 'signed-out' })
    })

    it('keeps a token in memory and reports when encryption is unavailable', async () => {
        runtime.encryption = false
        const instance = await signedIn()
        expect(existsSync(path.join(runtime.userData, 'sync-token.json'))).toBe(false)
        expect(await instance.state()).toMatchObject({
            status: 'idle',
            lastError: expect.stringContaining('仅保存在内存')
        })
        local('themes/theme.json', 'answer')
        await instance.syncNow()
        expect(github.text('themes/theme.json')).toBe('answer')
        expect(await instance.state()).toMatchObject({ lastError: expect.stringContaining('仅保存在内存') })
        expect(await manager().state()).toEqual({ status: 'signed-out' })
    })

    it('rejects invalid and empty tokens without saving them', async () => {
        const instance = manager()
        await expect(instance.loginToken('')).rejects.toThrow('令牌')
        await expect(instance.loginToken('invalid-test-token')).rejects.toThrow('401')
        expect(await instance.state()).toEqual({ status: 'signed-out' })
        expect(existsSync(path.join(runtime.userData, 'sync-token.json'))).toBe(false)
    })

    it('uses the built-in public Client ID when the override is empty', async () => {
        vi.useFakeTimers()
        settings.clientId = ''
        const instance = manager()
        const login = instance.loginDevice()
        await vi.advanceTimersByTimeAsync(1000)
        await login
        expect(github.requests.find((item) => item.route === '/login/device/code')?.body.client_id).toBe(
            BUILTIN_GITHUB_CLIENT_ID
        )
        expect(github.requests.find((item) => item.route === '/login/oauth/access_token')?.body.client_id).toBe(
            BUILTIN_GITHUB_CLIENT_ID
        )
    })

    it('emits the device code, opens GitHub, and respects pending and persistent slow_down intervals', async () => {
        vi.useFakeTimers()
        settings.clientId = 'test-client-id'
        github.deviceReplies = [
            { error: 'authorization_pending' },
            { error: 'slow_down' },
            { error: 'authorization_pending' },
            { access_token: FAKE_TOKEN }
        ]
        const instance = manager()
        const login = instance.loginDevice()
        await vi.advanceTimersByTimeAsync(0)
        expect(await instance.state()).toMatchObject({
            status: 'signing-in',
            userCode: 'TEST-CODE',
            verificationUri: 'https://github.com/login/device'
        })
        expect(runtime.open).toHaveBeenCalledWith('https://github.com/login/device')
        await vi.advanceTimersByTimeAsync(1000)
        expect(github.polls).toHaveLength(1)
        await vi.advanceTimersByTimeAsync(1000)
        expect(github.polls).toHaveLength(2)
        await vi.advanceTimersByTimeAsync(5999)
        expect(github.polls).toHaveLength(2)
        await vi.advanceTimersByTimeAsync(1)
        expect(github.polls).toHaveLength(3)
        await vi.advanceTimersByTimeAsync(6000)
        await login
        expect(github.polls.slice(1).map((time, index) => time - github.polls[index])).toEqual([1000, 6000, 6000])
        expect(await instance.state()).toMatchObject({ status: 'idle', account: { login: 'tester' } })
    })

    it.each(['expired_token', 'access_denied'])('stops polling on %s', async (error) => {
        vi.useFakeTimers()
        settings.clientId = 'test-client-id'
        github.deviceReplies = [{ error }]
        const instance = manager()
        const rejected = expect(instance.loginDevice()).rejects.toThrow(error === 'expired_token' ? '过期' : '拒绝')
        await vi.advanceTimersByTimeAsync(1000)
        await rejected
        await vi.advanceTimersByTimeAsync(20_000)
        expect(github.polls).toHaveLength(1)
        expect(await instance.state()).toEqual({ status: 'signed-out' })
    })

    it('honors local expiry without sending a late poll and cancels login on logout', async () => {
        vi.useFakeTimers()
        settings.clientId = 'test-client-id'
        github.deviceExpires = 1
        const instance = manager()
        const expired = expect(instance.loginDevice()).rejects.toThrow('过期')
        await vi.advanceTimersByTimeAsync(1000)
        await expired
        expect(github.polls).toHaveLength(0)
        github.deviceExpires = 60
        const cancelled = expect(instance.loginDevice()).rejects.toThrow('取消')
        await vi.advanceTimersByTimeAsync(0)
        await instance.logout()
        await cancelled
        await vi.advanceTimersByTimeAsync(10_000)
        expect(github.polls).toHaveLength(0)
        expect(await instance.state()).toEqual({ status: 'signed-out' })
    })
})

describe('Git Data three-way sync', () => {
    it('uploads exactly the shared configuration collector and never visits the problem store or plugin code', async () => {
        const instance = await signedIn()
        store.set({
            keybindings: { 'file.save': 'Ctrl+Alt+S' },
            template: '// template $0',
            pluginEnabled: { helper: false },
            recentFiles: ['private.cpp'],
            lastFolder: 'private'
        } as never)
        local('themes/custom.json', '{"id":"custom"}')
        local('fonts/custom.woff2', Buffer.from([0, 255, 1]))
        for (const name of [
            'problems/p/problem.json',
            'problems/p/code.cpp',
            'problems/p/tests/1.in',
            'library/snippet.cpp',
            'plugins/helper/index.cjs',
            'plugins/helper/iter-plugin.json',
            'plugin-data/helper/session.json',
            'themes/.iter/problem.json',
            'themes/hidden.cpp',
            'themes/script.js',
            'themes/theme.conflict-device.json'
        ])
            local(name, 'private data')
        const storePath = path.join(temporary, 'store')
        mkdirSync(storePath)
        writeFileSync(path.join(storePath, 'problem.json'), 'private problem')
        const entries = new Map<string, Buffer>()
        for await (const entry of collectConfig(store))
            if (!entry.name.endsWith('/')) entries.set(entry.name, entry.data)
        const result = await instance.syncNow()
        expect(result).toMatchObject({ uploaded: 3, downloaded: 0, conflicts: [], skipped: [] })
        expect([...github.files.keys()].sort()).toEqual([...entries.keys()].sort())
        for (const [name, data] of entries) expect(github.blobs.get(github.files.get(name)!.sha)).toEqual(data)
        const portable = JSON.parse(github.text('settings.json')!)
        expect(portable).toMatchObject({
            keybindings: { 'file.save': 'Ctrl+Alt+S' },
            template: '// template $0',
            pluginEnabled: { helper: false }
        })
        expect(portable).not.toHaveProperty('recentFiles')
        expect(portable).not.toHaveProperty('lastFolder')
        expect(readFileSync(path.join(storePath, 'problem.json'), 'utf8')).toBe('private problem')
    })

    it('ignores legacy remote store data and baselines without downloading, deleting or re-uploading them', async () => {
        const instance = await signedIn()
        const legacy = [
            'problems/p/problem.json',
            'problems/p/code.cpp',
            'tests/1.in',
            'library/code.cpp',
            'plugins/helper/index.cjs',
            'sync-token.json',
            'sync-state.json',
            'themes/old.conflict-device.json'
        ]
        for (const name of legacy.filter((name) => !name.startsWith('sync-'))) local(name, 'local private data')
        github.edit(Object.fromEntries(legacy.map((name) => [name, 'old remote data'])))
        saveBaseline(github.repo, {
            blobs: Object.fromEntries(legacy.map((name) => [name, github.files.get(name)!.sha]))
        })
        const result = await instance.syncNow()
        expect(result).toMatchObject({ uploaded: 1, downloaded: 0, conflicts: [] })
        expect(result.skipped.map((item) => item.path).sort()).toEqual([...legacy].sort())
        for (const name of legacy) expect(github.text(name)).toBe('old remote data')
        for (const name of legacy.filter((name) => !name.startsWith('sync-')))
            expect(text(name)).toBe('local private data')
        expect(Object.keys(loadBaseline(github.repo).blobs)).toEqual(['settings.json'])
        expect(github.requests.some((item) => item.method === 'GET' && item.route.includes('/git/blobs/'))).toBe(false)
        expect((await instance.syncNow()).uploaded).toBe(0)
    })

    it('applies portable settings to the live store, removes map keys, and retains local recent paths', async () => {
        const instance = await signedIn()
        store.set({
            keybindings: { 'file.save': 'Ctrl+Alt+S' },
            pluginEnabled: { helper: false },
            recentFiles: ['local.cpp']
        })
        await instance.syncNow()
        const current = store.get()
        const remote = JSON.parse(github.text('settings.json')!)
        remote.editor.fontSize = 22
        remote.theme = 'remote-theme'
        remote.template = '// remote template $0'
        remote.keybindings = {}
        remote.pluginEnabled = {}
        github.edit({ 'settings.json': JSON.stringify(remote, null, 2) })
        expect(await instance.syncNow()).toMatchObject({ uploaded: 0, downloaded: 1, conflicts: [] })
        expect(store.get()).toBe(current)
        expect(store.get()).toMatchObject({
            theme: 'remote-theme',
            editor: { fontSize: 22 },
            template: '// remote template $0',
            recentFiles: ['local.cpp']
        })
        expect(store.get().keybindings).toEqual({})
        expect(store.get().pluginEnabled).toEqual({})
        expect(JSON.parse(text('settings.json'))).toEqual(store.get())
        expect(await instance.syncNow()).toMatchObject({ uploaded: 0, downloaded: 0, conflicts: [] })
        github.edit({ 'settings.json': null })
        expect(await instance.syncNow()).toMatchObject({ uploaded: 1, downloaded: 0, conflicts: [] })
        expect(github.text('settings.json')).toBe(settingsContent(store).toString())
    })

    it('backs up settings changed during a download and keeps the backup local', async () => {
        const instance = await signedIn()
        await instance.syncNow()
        const remote = JSON.parse(github.text('settings.json')!)
        remote.theme = 'remote-theme'
        github.edit({ 'settings.json': JSON.stringify(remote, null, 2) })
        github.intercept = (request) => {
            if (request.method === 'GET' && request.route.includes('/git/blobs/'))
                store.set({ theme: 'late-local-theme' })
            return undefined
        }
        expect((await instance.syncNow()).conflicts).toEqual(['settings.json'])
        expect(store.get().theme).toBe('remote-theme')
        const backups = readdirSync(root).filter((name) => name.startsWith('settings.conflict-'))
        expect(backups).toHaveLength(1)
        expect(JSON.parse(text(backups[0])).theme).toBe('late-local-theme')
        github.intercept = undefined
        expect(await instance.syncNow()).toMatchObject({ uploaded: 0, downloaded: 0, conflicts: [] })
        expect(github.files.has(backups[0])).toBe(false)
    })

    it.each([
        'not JSON',
        '{"editor":{"fontSize":"invalid"}}',
        '{"pluginEnabled":{"helper":"false"}}',
        '{"editor":{"completion":{"snippets":{}}}}',
        '{"keybindings":{"file.save":42}}',
        '{"toolchain":{"parallel":0}}'
    ])('rejects invalid remote settings without changing live or persisted settings: %s', async (content) => {
        const instance = await signedIn()
        store.set({ theme: 'local-theme' })
        await instance.syncNow()
        const persisted = text('settings.json')
        const baseline = loadBaseline(github.repo)
        github.edit({ 'settings.json': content })
        await expect(instance.syncNow()).rejects.toThrow(/Invalid/)
        expect(store.get().theme).toBe('local-theme')
        expect(text('settings.json')).toBe(persisted)
        expect(loadBaseline(github.repo)).toEqual(baseline)
    })

    it('computes canonical Git blob hashes including the size and NUL header', () => {
        expect(blobSha(Buffer.alloc(0))).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
        expect(blobSha(Buffer.from('hello'))).toBe('b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0')
    })

    it('creates a private repository and uploads over 100 files in one tree/commit with bounded concurrency', async () => {
        github.exists = false
        const instance = await signedIn()
        for (let index = 0; index < 115; index++) local(`themes/${index}/theme.json`, `solution ${index}`)
        const result = await instance.syncNow()
        expect(result).toEqual({ uploaded: 116, downloaded: 0, conflicts: [], skipped: [] })
        expect(github.text('themes/114/theme.json')).toBe('solution 114')
        expect(github.requests.find((item) => item.route === '/user/repos')?.body).toEqual({
            name: 'iter-sync',
            private: true,
            auto_init: true
        })
        expect(posts('/git/trees')).toBe(1)
        expect(posts('/git/commits')).toBe(1)
        expect(github.maxConcurrent).toBeLessThanOrEqual(4)
        expect(states.some((state) => state.status === 'syncing')).toBe(true)
        expect(await instance.state()).toMatchObject({ status: 'idle', lastSync: expect.any(Number) })
        expect((await instance.syncNow()).uploaded).toBe(0)
        expect(posts('/git/blobs')).toBe(116)
        expect(posts('/git/commits')).toBe(1)
    })

    it('downloads remote-only files and remote edits, including binary content, after restart', async () => {
        const instance = await signedIn()
        local('themes/p/theme.json', 'base')
        await instance.syncNow()
        github.edit({ 'themes/p/theme.json': 'remote', 'fonts/custom.woff2': Buffer.from([0, 1, 255, 10]) })
        const restored = manager()
        expect((await restored.syncNow()).downloaded).toBe(2)
        expect(text('themes/p/theme.json')).toBe('remote')
        expect(readFileSync(path.join(root, 'fonts/custom.woff2'))).toEqual(Buffer.from([0, 1, 255, 10]))
        expect(readdirSync(path.join(root, 'themes/p'))).toEqual(['theme.json'])
        const baseline = JSON.parse(readFileSync(path.join(runtime.userData, 'sync-state.json'), 'utf8'))
        expect(baseline.repositories['tester/iter-sync'].commit).toBe(github.head)
    })

    it('uploads local edits and preserves both sides of a concurrent edit as a conflict copy', async () => {
        const instance = await signedIn()
        local('themes/p/theme.json', 'base')
        await instance.syncNow()
        local('themes/p/theme.json', 'local only')
        expect((await instance.syncNow()).uploaded).toBe(1)
        expect(github.text('themes/p/theme.json')).toBe('local only')
        local('themes/p/theme.json', 'my concurrent work')
        github.edit({ 'themes/p/theme.json': 'remote work' })
        const result = await instance.syncNow()
        expect(result.conflicts).toEqual(['themes/p/theme.json'])
        expect(text('themes/p/theme.json')).toBe('remote work')
        const copy = readdirSync(path.join(root, 'themes/p')).find((name) => /^theme\.conflict-.+\.json$/.test(name))!
        expect(text(`themes/p/${copy}`)).toBe('my concurrent work')
        await instance.syncNow()
        expect(github.text(`themes/p/${copy}`)).toBeUndefined()
    })

    it.each([
        ['local deletion', null, 'base', undefined],
        ['remote deletion', 'base', null, undefined],
        ['local deletion vs remote edit', null, 'remote edit', 'remote edit'],
        ['remote deletion vs local edit', 'local edit', null, 'local edit']
    ] as const)('handles %s without losing edits', async (_name, localChange, remoteChange, expected) => {
        const instance = await signedIn()
        local('themes/theme.json', 'base')
        await instance.syncNow()
        if (localChange === null) unlinkSync(path.join(root, 'themes/theme.json'))
        else local('themes/theme.json', localChange)
        if (remoteChange !== 'base') github.edit({ 'themes/theme.json': remoteChange })
        await instance.syncNow()
        expect(existsSync(path.join(root, 'themes/theme.json')) ? text('themes/theme.json') : undefined).toBe(expected)
        expect(github.text('themes/theme.json')).toBe(expected)
        expect(await instance.syncNow()).toMatchObject({ uploaded: 0, downloaded: 0, conflicts: [] })
        if (expected === undefined) {
            // A deletion must clear its baseline; later re-creation of identical content is new data.
            github.edit({ 'themes/theme.json': 'base' })
            await instance.syncNow()
            expect(text('themes/theme.json')).toBe('base')
        }
    })

    it('preserves an editor save racing with remote publication', async () => {
        const instance = await signedIn()
        local('themes/theme.json', 'base')
        await instance.syncNow()
        github.edit({ 'themes/theme.json': 'remote edit' })
        const link = fs.link.bind(fs)
        let saved = false
        vi.spyOn(fs, 'link').mockImplementation(async (source, target) => {
            if (!saved && String(target) === path.join(root, 'themes/theme.json')) {
                saved = true
                local('themes/theme.json', 'save during publication')
            }
            return link(source, target)
        })
        expect((await instance.syncNow()).conflicts).toEqual(['themes/theme.json'])
        expect(text('themes/theme.json')).toBe('remote edit')
        const copies = readdirSync(path.join(root, 'themes')).filter((name) => name.includes('.conflict-'))
        expect(copies).toHaveLength(1)
        expect(text(`themes/${copies[0]}`)).toBe('save during publication')
    })

    it('keeps an editor save racing with a remote deletion', async () => {
        const instance = await signedIn()
        local('themes/theme.json', 'base')
        await instance.syncNow()
        github.edit({ 'themes/theme.json': null })
        const rename = fs.rename.bind(fs)
        let saved = false
        vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
            if (!saved && String(source) === path.join(root, 'themes/theme.json')) {
                saved = true
                local('themes/theme.json', 'save during deletion')
            }
            return rename(source, target)
        })
        await instance.syncNow()
        expect(text('themes/theme.json')).toBe('save during deletion')
        await instance.syncNow()
        expect(github.text('themes/theme.json')).toBe('save during deletion')
    })

    it('reports oversized local files and never interprets a skipped tracked file as a deletion', async () => {
        const instance = await signedIn()
        local('themes/theme.json', 'base')
        await instance.syncNow()
        settings.maxFileBytes = 8
        local('themes/theme.json', 'larger than allowed')
        local('fonts/large.woff2', 'a'.repeat(32))
        local('fonts/small.woff2', 'small')
        local('themes/save.tmp', 'temporary')
        local('themes/store.lock', 'lock')
        const result = await instance.syncNow()
        expect(result.skipped.map((item) => item.path).sort()).toEqual([
            'fonts/large.woff2',
            'settings.json',
            'themes/theme.json'
        ])
        expect(github.text('themes/theme.json')).toBe('base')
        expect(github.text('fonts/small.woff2')).toBe('small')
        expect(github.files.has('themes/save.tmp')).toBe(false)
        expect(github.files.has('themes/store.lock')).toBe(false)
        expect(text('themes/theme.json')).toBe('larger than allowed')
    })

    it('skips oversized remote files, traversal paths, and symlinked directories', async () => {
        const instance = await signedIn()
        local('themes/theme.json', 'base')
        await instance.syncNow()
        const outside = path.join(temporary, 'outside')
        mkdirSync(outside)
        await fs.symlink(outside, path.join(root, 'themes/linked'), 'junction')
        settings.maxFileBytes = 8
        github.edit({
            'themes/theme.json': 'remote too large',
            '../escaped.txt': 'escape',
            'themes/linked/data.json': 'external'
        })
        const result = await instance.syncNow()
        expect(result.skipped.map((item) => item.path)).toEqual(
            expect.arrayContaining(['themes/theme.json', '../escaped.txt', 'themes/linked', 'themes/linked/data.json'])
        )
        expect(text('themes/theme.json')).toBe('base')
        expect(existsSync(path.join(temporary, 'escaped.txt'))).toBe(false)
        expect(readdirSync(outside)).toEqual([])
    })

    it('returns to idle on offline errors and clears the error after a successful retry', async () => {
        const instance = await signedIn()
        local('themes/theme.json', 'unsynced work')
        github.offline = true
        await expect(instance.syncNow()).rejects.toThrow('网络')
        expect(await instance.state()).toMatchObject({ status: 'idle', lastError: expect.stringContaining('网络') })
        expect(text('themes/theme.json')).toBe('unsynced work')
        expect(existsSync(path.join(runtime.userData, 'sync-state.json'))).toBe(false)
        github.offline = false
        await instance.syncNow()
        expect(await instance.state()).toMatchObject({ status: 'idle', lastError: undefined })
    })

    it('reports rate-limit headers without exposing an error response body', async () => {
        const instance = await signedIn()
        github.intercept = () =>
            json({ message: FAKE_TOKEN }, 403, { 'x-ratelimit-remaining': '0', 'retry-after': '60' })
        await expect(instance.syncNow()).rejects.toThrow('60 秒后')
        const state = await instance.state()
        expect(state).toMatchObject({ status: 'idle', lastError: expect.stringContaining('频率受限') })
        expect(JSON.stringify(state)).not.toContain(FAKE_TOKEN)
    })

    it('rejects concurrent branch movement and truncated trees without overwriting either side', async () => {
        const instance = await signedIn()
        local('themes/theme.json', 'base')
        await instance.syncNow()
        local('themes/theme.json', 'local edit')
        github.intercept = (request) => {
            if (request.method === 'PATCH') github.edit({ 'themes/theme.json': 'other device' })
            return undefined
        }
        await expect(instance.syncNow()).rejects.toThrow('422')
        expect(text('themes/theme.json')).toBe('local edit')
        expect(github.text('themes/theme.json')).toBe('other device')
        github.intercept = undefined
        github.truncated = true
        await expect(instance.syncNow()).rejects.toThrow('截断')
        expect(text('themes/theme.json')).toBe('local edit')
        github.truncated = false
        expect((await instance.syncNow()).conflicts).toEqual(['themes/theme.json'])
    })

    it('coalesces overlapping sync requests into one cycle', async () => {
        const instance = await signedIn()
        local('themes/theme.json', 'base')
        const [first, second] = await Promise.all([instance.syncNow(), instance.syncNow()])
        expect(first).toEqual(second)
        expect(posts('/git/commits')).toBe(1)
    })

    it('runs a startup sync even in manual mode and re-reads interval settings each cycle', async () => {
        vi.useFakeTimers()
        const instance = await signedIn()
        const sync = vi
            .spyOn(instance, 'syncNow')
            .mockResolvedValue({ uploaded: 0, downloaded: 0, conflicts: [], skipped: [] })
        await vi.advanceTimersByTimeAsync(1499)
        expect(sync).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(sync).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(90_000)
        expect(sync).toHaveBeenCalledTimes(1)
        settings.intervalMin = 1
        await vi.advanceTimersByTimeAsync(30_000)
        expect(sync).toHaveBeenCalledTimes(2)
        settings.intervalMin = 0
        await vi.advanceTimersByTimeAsync(90_000)
        expect(sync).toHaveBeenCalledTimes(2)
    })
})
