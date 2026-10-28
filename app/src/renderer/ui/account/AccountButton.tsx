import { store } from '../../state/app'
import { Icon } from '../Icon'
import { useSyncState } from './useSync'

/** Title-bar entry to the sign-in / sync page: avatar when signed in, a small dot while syncing. */
export function AccountButton() {
    const s = useSyncState()
    const account = s && (s.status === 'idle' || s.status === 'syncing') ? s.account : null
    const error = s?.status === 'idle' && s.lastError
    return (
        <button
            className={`nv-ghost nv-icon-btn nv-account-btn ${s?.status === 'syncing' ? 'is-syncing' : ''} ${error ? 'is-error' : ''}`}
            onClick={() => store.set({ accountOpen: true })}
            title={account ? `@${account.login}` : 'GitHub 同步'}
        >
            {account?.avatarUrl ? (
                <img src={account.avatarUrl} alt="" />
            ) : (
                <Icon name={account ? 'cloud' : 'user'} size={15} />
            )}
        </button>
    )
}
