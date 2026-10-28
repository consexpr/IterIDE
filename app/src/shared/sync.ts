// GitHub sync of portable configuration collected by main/configBundle (never the problem store).

/**
 * Client ID of ITER's own GitHub OAuth App (device flow). Client IDs are public, not secrets:
 * shipping it lets users sign in with one click instead of registering an app themselves.
 * Device flow is enabled. Its OAuth access tokens do not expire (they can be revoked).
 */
export const BUILTIN_GITHUB_CLIENT_ID = 'Ov23li0fKDLZXNdvHDVp'

export interface SyncAccount {
    login: string
    name?: string
    avatarUrl?: string
}

export type SyncState =
    | { status: 'signed-out' }
    | { status: 'signing-in'; userCode: string; verificationUri: string; expiresAt: number }
    | { status: 'idle'; account: SyncAccount; repo: string; lastSync?: number; lastError?: string }
    | { status: 'syncing'; account: SyncAccount; repo: string; progress?: string }

export interface SyncSettings {
    /** GitHub OAuth App client id override; empty uses ITER's built-in device-flow app. */
    clientId: string
    /** `owner/name` of the private repo; default `<login>/iter-sync`. */
    repo: string
    /** Minutes between automatic syncs; 0 = manual only. */
    intervalMin: number
    /** Files larger than this are not uploaded (bytes). */
    maxFileBytes: number
}

export interface SyncResult {
    uploaded: number
    downloaded: number
    conflicts: string[]
    skipped: { path: string; reason: string }[]
}
