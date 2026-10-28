import { app, shell } from 'electron'
import type { SyncAccount, SyncResult, SyncSettings, SyncState } from '../../shared/sync'
import { BUILTIN_GITHUB_CLIENT_ID } from '../../shared/sync'
import { LEGACY_SYNC_REPOSITORY } from '../../shared/legacyBrand'
import type { SettingsStore } from '../settings'
import { syncCycle } from './engine'
import { GitHubClient, GitHubError, repoRoute } from './github'
import { deleteCredentials, loadBaseline, loadCredentials, saveCredentials } from './storage'

/** Optional endpoint overrides are for fake-API tests; IPC keeps the two-argument API. */
export interface SyncManagerOptions {
    apiBaseUrl?: string
    authBaseUrl?: string
}

export class SyncManager {
    private current: SyncState = { status: 'signed-out' }
    private token?: string
    private account?: SyncAccount
    private warning?: string
    private lastError?: string
    private session = new AbortController()
    private authVersion = 0
    private activeSync?: Promise<SyncResult>
    private timer?: ReturnType<typeof setTimeout>
    private startupDue?: number
    private lastAttempt = Date.now()
    private stopped = false
    private authenticating = false

    constructor(
        private readonly settings: SettingsStore,
        private readonly emit: (s: SyncState) => void,
        private readonly options: SyncManagerOptions = {}
    ) {
        const saved = loadCredentials()
        if (saved) {
            this.token = saved.token
            this.account = saved.account
            this.startupDue = Date.now() + 1500
            this.idle()
        }
        this.schedule()
        app.once?.('will-quit', () => {
            void this.dispose()
        })
    }

    async dispose(): Promise<void> {
        this.stopped = true
        clearTimeout(this.timer)
        this.session.abort()
        await this.activeSync?.catch(() => {})
    }

    async state(): Promise<SyncState> {
        if (this.current.status === 'idle') this.idle()
        return this.current
    }

    async loginToken(token: string): Promise<void> {
        if (typeof token !== 'string' || !token.trim()) throw new Error('请输入 GitHub 令牌。')
        const version = this.beginLogin()
        try {
            await this.acceptToken(token.trim(), version)
        } catch (error) {
            this.loginFailed(error, version)
            throw error
        }
    }

    async loginDevice(): Promise<void> {
        // a user-entered Client ID wins; otherwise ITER's own OAuth App
        const clientId = this.config().clientId.trim() || BUILTIN_GITHUB_CLIENT_ID
        if (!clientId) throw new Error('未配置 GitHub OAuth App：请使用令牌登录，或在「高级」中填写 Client ID。')
        const version = this.beginLogin()
        const signal = this.session.signal
        const client = this.client('')
        try {
            const device = await client.request<{
                device_code: string
                user_code: string
                verification_uri: string
                expires_in: number
                interval?: number
                error?: string
            }>('/login/device/code', 'POST', { client_id: clientId, scope: 'repo' }, false)
            this.checkLogin(version)
            const uri = new URL(device.verification_uri)
            if (
                device.error ||
                !device.device_code ||
                !device.user_code ||
                uri.protocol !== 'https:' ||
                uri.hostname !== 'github.com' ||
                uri.username ||
                uri.password ||
                !Number.isFinite(device.expires_in) ||
                device.expires_in <= 0
            ) {
                throw new Error('无法启动 GitHub 设备登录，请确认 OAuth App 已启用 Device Flow。')
            }
            const expiresAt = Date.now() + device.expires_in * 1000
            let interval = Number.isFinite(device.interval) && device.interval! > 0 ? device.interval! * 1000 : 5000
            this.transition({ status: 'signing-in', userCode: device.user_code, verificationUri: uri.href, expiresAt })
            await shell.openExternal(uri.href)
            while (Date.now() < expiresAt) {
                await delay(Math.min(interval, expiresAt - Date.now()), signal)
                this.checkLogin(version)
                if (Date.now() >= expiresAt) break
                const response = await client.request<{ access_token?: string; error?: string }>(
                    '/login/oauth/access_token',
                    'POST',
                    {
                        client_id: clientId,
                        device_code: device.device_code,
                        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
                    },
                    false
                )
                this.checkLogin(version)
                if (response.access_token) {
                    await this.acceptToken(response.access_token, version)
                    return
                }
                if (response.error === 'authorization_pending') continue
                if (response.error === 'slow_down') {
                    interval += 5000
                    continue
                }
                if (response.error === 'expired_token') break
                if (response.error === 'access_denied') throw new Error('GitHub 设备登录已被拒绝。')
                throw new Error('GitHub 设备登录失败，请检查 OAuth App 配置后重试。')
            }
            throw new Error('GitHub 设备登录已过期，请重新登录。')
        } catch (error) {
            this.loginFailed(error, version)
            throw error
        }
    }

    async logout(): Promise<void> {
        ++this.authVersion
        this.session.abort()
        this.session = new AbortController()
        this.token = undefined
        this.account = undefined
        this.warning = undefined
        this.lastError = undefined
        this.startupDue = undefined
        this.authenticating = false
        this.transition({ status: 'signed-out' })
        deleteCredentials()
        // No already-started disk operation may outlive a completed logout.
        await this.activeSync?.catch(() => undefined)
    }

    async syncNow(): Promise<SyncResult> {
        if (this.authenticating) throw new Error('请等待 GitHub 登录完成。')
        if (this.activeSync) return this.activeSync
        if (!this.token || !this.account) throw new Error('请先登录 GitHub。')
        if (this.current.status === 'signing-in') throw new Error('请等待 GitHub 登录完成。')
        const account = this.account
        const version = this.authVersion
        const signal = this.session.signal
        const config = this.config()
        const repo = this.repo()
        this.lastAttempt = Date.now()
        this.startupDue = undefined
        this.lastError = undefined
        this.transition({ status: 'syncing', account, repo })
        const run = async (): Promise<SyncResult> => {
            try {
                repoRoute(repo)
                return await syncCycle({
                    settings: this.settings,
                    repo,
                    login: account.login,
                    maxBytes: config.maxFileBytes,
                    client: this.client(this.token!),
                    signal,
                    progress: (progress) => {
                        if (!signal.aborted) this.transition({ status: 'syncing', account, repo, progress })
                    }
                })
            } catch (error) {
                if (version === this.authVersion) this.lastError = errorMessage(error)
                throw error
            } finally {
                if (version === this.authVersion) this.idle()
            }
        }
        this.activeSync = run()
        try {
            return await this.activeSync
        } finally {
            this.activeSync = undefined
        }
    }

    private config(): SyncSettings {
        const settings = this.settings.get().sync
        return {
            clientId: settings?.clientId ?? '',
            repo: settings?.repo ?? '',
            intervalMin: Number.isFinite(settings?.intervalMin) ? Math.max(0, settings.intervalMin) : 30,
            maxFileBytes: Number.isFinite(settings?.maxFileBytes)
                ? Math.max(0, Math.floor(settings.maxFileBytes))
                : 50 * 1024 * 1024
        }
    }

    private repo(): string {
        const configured = this.config().repo.trim()
        if (configured) return configured
        const login = this.account?.login ?? ''
        const legacy = `${login}/${LEGACY_SYNC_REPOSITORY}`
        // Existing users keep their established remote; a rename must not silently create a second repository.
        const baseline = loadBaseline(legacy)
        return baseline.commit || baseline.lastSync ? legacy : `${login}/iter-sync`
    }

    private client(token: string): GitHubClient {
        return new GitHubClient(token, this.options.apiBaseUrl, this.options.authBaseUrl, this.session.signal)
    }

    private transition(state: SyncState): void {
        this.current = state
        this.emit(state)
    }

    private idle(): void {
        if (!this.account) {
            this.transition({ status: 'signed-out' })
            return
        }
        const repo = this.repo()
        this.transition({
            status: 'idle',
            account: this.account,
            repo,
            lastSync: loadBaseline(repo).lastSync,
            lastError: [this.warning, this.lastError].filter(Boolean).join(' ') || undefined
        })
    }

    private beginLogin(): number {
        this.authenticating = true
        this.startupDue = undefined
        this.session.abort()
        this.session = new AbortController()
        return ++this.authVersion
    }

    private checkLogin(version: number): void {
        if (version !== this.authVersion || this.session.signal.aborted) throw new Error('GitHub 登录已取消。')
    }

    private async acceptToken(token: string, version: number): Promise<void> {
        const user = await this.client(token).request<{ login: string; name?: string; avatar_url?: string }>('/user')
        this.checkLogin(version)
        if (typeof user.login !== 'string' || !/^[a-zA-Z0-9-]+$/.test(user.login))
            throw new Error('GitHub 返回了无效的用户信息。')
        await this.activeSync?.catch(() => undefined)
        this.checkLogin(version)
        this.account = { login: user.login, name: user.name || undefined, avatarUrl: user.avatar_url }
        this.token = token
        this.warning = saveCredentials(token, this.account)
        this.authenticating = false
        this.lastError = undefined
        this.startupDue = Date.now() + 1500
        this.idle()
        this.schedule(1500)
    }

    private loginFailed(error: unknown, version: number): void {
        if (version !== this.authVersion) return
        this.authenticating = false
        this.lastError = errorMessage(error)
        this.idle()
    }

    private schedule(wait = 30_000): void {
        clearTimeout(this.timer)
        if (this.stopped) return
        if (this.startupDue) wait = Math.min(wait, Math.max(1, this.startupDue - Date.now()))
        this.timer = setTimeout(() => {
            const interval = this.config().intervalMin * 60_000
            const due = this.startupDue !== undefined && Date.now() >= this.startupDue
            if (
                this.token &&
                !this.authenticating &&
                !this.activeSync &&
                (due || (interval > 0 && Date.now() - this.lastAttempt >= interval))
            ) {
                this.startupDue = undefined
                this.lastAttempt = Date.now()
                void this.syncNow()
                    .catch(() => undefined)
                    .finally(() => this.schedule())
            } else this.schedule()
        }, wait)
        this.timer.unref()
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'GitHub 同步失败，请重试。'
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const abort = (): void => {
            clearTimeout(timer)
            reject(new GitHubError('GitHub 登录已取消。'))
        }
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', abort)
            resolve()
        }, ms)
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
    })
}
