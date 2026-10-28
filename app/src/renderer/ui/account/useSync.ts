import { useEffect, useState } from 'react'
import type { SyncState } from '../../../shared/sync'

/** Live sync state from the main process. */
export function useSyncState(): SyncState | null {
    const [s, setS] = useState<SyncState | null>(null)
    useEffect(() => {
        void window.iter.sync
            .state()
            .then(setS)
            .catch(() => setS({ status: 'signed-out' }))
        return window.iter.sync.onState(setS)
    }, [])
    return s
}
