import { APP_WORDMARK } from '../../../shared/brand'
// Sign-in & sync page: looping hero video on the left, the current sync state on the right.
import { useEffect, useState } from 'react'
import { BUILTIN_GITHUB_CLIENT_ID, type SyncState } from '../../../shared/sync'
import { updateSettings } from '../../actions/settings'
import heroVideo from '../../assets/login-hero.mp4'
import { store, toast, useApp } from '../../state/app'
import { Icon, Logo } from '../Icon'
import { useSyncState } from './useSync'

const close = (): void => store.set({ accountOpen: false })

export function AccountPage() {
    const state = useSyncState()
    useEffect(() => {
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') close()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [])

    return (
        <div className="nv-account" onMouseDown={(e) => e.target === e.currentTarget && close()}>
            <div className="nv-account-card">
                <div className="nv-account-hero">
                    <video src={heroVideo} autoPlay muted loop playsInline />
                    <div className="nv-account-brand">
                        <Logo size={28} />
                        <span className="nv-wordmark">{APP_WORDMARK}</span>
                    </div>
                </div>
                <div className="nv-account-body">
                    <button className="nv-icon-btn nv-account-close" onClick={close} title="关闭 (Esc)">
                        <Icon name="x" size={15} />
                    </button>
                    {!state || state.status === 'signed-out' ? (
                        <SignedOut />
                    ) : state.status === 'signing-in' ? (
                        <SigningIn s={state} />
                    ) : (
                        <SignedIn s={state} />
                    )}
                </div>
            </div>
        </div>
    )
}

function SignedOut() {
    const clientId = useApp((s) => s.settings.sync.clientId) || BUILTIN_GITHUB_CLIENT_ID
    const [tokenMode, setTokenMode] = useState(false)
    const [advanced, setAdvanced] = useState(!clientId)
    const [token, setToken] = useState('')
    const [busy, setBusy] = useState(false)
    const run = async (job: () => Promise<void>): Promise<void> => {
        setBusy(true)
        try {
            await job()
        } catch (e) {
            toast((e as Error).message, 'error', 6000)
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="nv-account-pane">
            <h2>登录 GitHub</h2>
            {!tokenMode ? (
                <>
                    <button
                        className="nv-btn is-primary nv-account-cta"
                        disabled={busy || !clientId}
                        onClick={() => void run(() => window.iter.sync.loginDevice())}
                    >
                        <Icon name="github" size={16} /> 使用 GitHub 登录
                    </button>
                    <button className="nv-account-link" onClick={() => setTokenMode(true)}>
                        使用访问令牌
                    </button>
                    {advanced ? (
                        <label className="nv-account-field">
                            <span>OAuth Client ID</span>
                            <input
                                value={clientId}
                                spellCheck={false}
                                onChange={(e) => void updateSettings({ sync: { clientId: e.target.value.trim() } })}
                            />
                        </label>
                    ) : (
                        <button className="nv-account-link is-faint" onClick={() => setAdvanced(true)}>
                            高级
                        </button>
                    )}
                </>
            ) : (
                <>
                    <label className="nv-account-field">
                        <span>访问令牌</span>
                        <input
                            type="password"
                            value={token}
                            spellCheck={false}
                            placeholder="github_pat_…"
                            onChange={(e) => setToken(e.target.value)}
                        />
                    </label>
                    <button
                        className="nv-btn is-primary nv-account-cta"
                        disabled={busy || !token.trim()}
                        onClick={() => void run(() => window.iter.sync.loginToken(token.trim()))}
                    >
                        登录
                    </button>
                    <button className="nv-account-link" onClick={() => setTokenMode(false)}>
                        改用浏览器登录
                    </button>
                </>
            )}
            <div className="nv-flex" />
            <button className="nv-account-skip" onClick={close}>
                暂不登录
            </button>
        </div>
    )
}

function SigningIn({ s }: { s: Extract<SyncState, { status: 'signing-in' }> }) {
    // the browser opens by itself; with the code already on the clipboard the user only pastes it
    useEffect(() => {
        void navigator.clipboard.writeText(s.userCode).catch(() => {})
    }, [s.userCode])
    return (
        <div className="nv-account-pane">
            <h2>在浏览器中粘贴验证码</h2>
            <div className="nv-device-code">
                {s.userCode.split('').map((c, i) => (
                    <span key={i} className={c === '-' ? 'is-dash' : ''}>
                        {c}
                    </span>
                ))}
            </div>
            <div className="nv-row is-tight">
                <button
                    className="nv-btn"
                    onClick={() =>
                        void navigator.clipboard.writeText(s.userCode).then(() => toast('已复制', 'success'))
                    }
                >
                    <Icon name="copy" size={14} /> 复制
                </button>
                <button className="nv-btn" onClick={() => void window.iter.app.openExternal(s.verificationUri)}>
                    <Icon name="link" size={14} /> {s.verificationUri.replace(/^https?:\/\//, '')}
                </button>
            </div>
            <div className="nv-account-wait">
                <span className="nv-breath" /> 等待授权
            </div>
            <div className="nv-flex" />
            <button className="nv-account-skip" onClick={() => void window.iter.sync.logout()}>
                取消
            </button>
        </div>
    )
}

const INTERVALS = [
    { v: 0, label: '手动' },
    { v: 15, label: '15 分钟' },
    { v: 30, label: '30 分钟' },
    { v: 60, label: '1 小时' }
]

function SignedIn({ s }: { s: Extract<SyncState, { status: 'idle' | 'syncing' }> }) {
    const interval = useApp((x) => x.settings.sync.intervalMin)
    const syncing = s.status === 'syncing'
    const syncNow = async (): Promise<void> => {
        try {
            const r = await window.iter.sync.syncNow()
            const parts = [`上传 ${r.uploaded}`, `下载 ${r.downloaded}`]
            if (r.conflicts.length) parts.push(`冲突 ${r.conflicts.length}`)
            if (r.skipped.length) parts.push(`跳过 ${r.skipped.length}`)
            toast(`同步完成：${parts.join(' · ')}`, r.conflicts.length ? 'info' : 'success', 5000)
        } catch (e) {
            toast((e as Error).message, 'error', 6000)
        }
    }
    return (
        <div className="nv-account-pane">
            <div className="nv-account-user">
                {s.account.avatarUrl ? (
                    <img src={s.account.avatarUrl} alt="" />
                ) : (
                    <span className="nv-avatar-fallback">{s.account.login[0]?.toUpperCase()}</span>
                )}
                <div>
                    <b>{s.account.name || s.account.login}</b>
                    <span className="nv-faint">@{s.account.login}</span>
                </div>
            </div>

            <div className="nv-account-rows">
                <div>
                    <span>仓库</span>
                    <button
                        className="nv-account-link"
                        onClick={() => void window.iter.app.openExternal(`https://github.com/${s.repo}`)}
                    >
                        {s.repo}
                    </button>
                </div>
                <div>
                    <span>上次同步</span>
                    <b>
                        {syncing
                            ? (s.progress ?? '同步中…')
                            : s.status === 'idle' && s.lastSync
                              ? ago(s.lastSync)
                              : '—'}
                    </b>
                </div>
                {s.status === 'idle' && s.lastError && (
                    <div className="is-error">
                        <span>错误</span>
                        <b title={s.lastError}>{s.lastError}</b>
                    </div>
                )}
                <div>
                    <span>自动同步</span>
                    <div className="nv-seg nv-seg-sm">
                        {INTERVALS.map((i) => (
                            <button
                                key={i.v}
                                className={interval === i.v ? 'is-on' : ''}
                                onClick={() => void updateSettings({ sync: { intervalMin: i.v } })}
                            >
                                {i.label}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            <button className="nv-btn is-primary nv-account-cta" disabled={syncing} onClick={() => void syncNow()}>
                {syncing ? <span className="nv-breath" /> : <Icon name="cloud" size={15} />}{' '}
                {syncing ? '同步中' : '立即同步'}
            </button>
            <div className="nv-flex" />
            <button className="nv-account-skip" onClick={() => void window.iter.sync.logout()}>
                退出登录
            </button>
        </div>
    )
}

function ago(t: number): string {
    const s = Math.round((Date.now() - t) / 1000)
    if (s < 60) return '刚刚'
    if (s < 3600) return `${Math.round(s / 60)} 分钟前`
    if (s < 86400) return `${Math.round(s / 3600)} 小时前`
    return new Date(t).toLocaleString()
}
