import { LEGACY_BRAND } from '../../shared/legacyBrand'

/** Copy a previous branding key on first read; existing ITER preferences always win. */
export function storedValue(key: string, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): string | null {
    const current = storage.getItem(key)
    if (current !== null || !key.startsWith('iter.')) return current
    const legacy = storage.getItem(`${LEGACY_BRAND}.${key.slice('iter.'.length)}`)
    if (legacy !== null) {
        try {
            storage.setItem(key, legacy)
        } catch {
            /* A read-only store can still supply the previous preference. */
        }
    }
    return legacy
}

// localStorage wrappers for per-viewer UI conveniences (panel width, watches). Never throw.
export function load<T>(key: string, fallback: T): T {
    try {
        const raw = storedValue(key)
        return raw === null ? fallback : (JSON.parse(raw) as T)
    } catch {
        return fallback
    }
}

export function save(key: string, value: unknown): void {
    try {
        localStorage.setItem(key, JSON.stringify(value))
    } catch {
        /* storage unavailable */
    }
}
