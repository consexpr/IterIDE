export type CompletionUsage = Record<string, number>
type UsageStorage = Pick<Storage, 'getItem' | 'setItem'>
const STORAGE_KEY = 'iter.cpp.completion.usage.v1'

function browserStorage(): UsageStorage | undefined {
    try {
        return globalThis.localStorage
    } catch {
        return undefined
    }
}

/** Counts accepted items, never impressions. Config bundles can use exportUsage/importUsage. */
export class CompletionUsageStore {
    private counts = new Map<string, number>()
    constructor(private readonly storage = browserStorage()) {
        try {
            this.importUsage(JSON.parse(storage ? (storedValue(STORAGE_KEY, storage) ?? '{}') : '{}'))
        } catch {
            /* Storage is optional. */
        }
    }
    frequency(key: string): number {
        return this.counts.get(key) ?? 0
    }
    record(key: string): void {
        if (!key || key.length > 256) return
        this.counts.set(key, Math.min(Number.MAX_SAFE_INTEGER, this.frequency(key) + 1))
        this.persist()
    }
    exportUsage(): CompletionUsage {
        return Object.fromEntries(this.counts)
    }
    /** Merge by maximum so importing the same bundle twice does not inflate counts. */
    importUsage(value: unknown): void {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return
        for (const [key, count] of Object.entries(value).slice(0, 10000)) {
            if (key && key.length <= 256 && typeof count === 'number' && Number.isSafeInteger(count) && count > 0) {
                this.counts.set(key, Math.max(this.frequency(key), count))
            }
        }
        this.persist()
    }
    private persist(): void {
        try {
            this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.exportUsage()))
        } catch {
            /* Quota/disabled storage must not break completion. */
        }
    }
}
import { storedValue } from '../util/storage'
