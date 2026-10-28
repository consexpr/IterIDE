import { randomUUID } from 'node:crypto'
import { API_HISTORY_LIMIT, type ApiCall, type ApiHistoryState } from '../../shared/apiHistory'

/** Session-only bounded history. Removed pending entries are never recreated by completion. */
export class ApiHistory {
    private records: ApiCall[] = []
    private revision = 0
    constructor(private readonly changed: () => void = () => {}) {}
    snapshot(): ApiHistoryState {
        return { revision: this.revision, records: this.records.map((record) => ({ ...record })) }
    }
    start(record: Omit<ApiCall, 'id'>): string {
        const id = randomUUID()
        this.records.unshift({ ...record, id })
        this.records.length = Math.min(this.records.length, API_HISTORY_LIMIT)
        this.notify()
        return id
    }
    finish(
        id: string,
        patch: Partial<Pick<ApiCall, 'status' | 'durationMs' | 'output' | 'error' | 'httpStatus'>>
    ): void {
        const record = this.records.find((record) => record.id === id)
        if (!record) return
        Object.assign(record, patch)
        this.notify()
    }
    delete(id: string): void {
        this.records = this.records.filter((record) => record.id !== id)
        this.notify()
    }
    clear(): void {
        this.records = []
        this.notify()
    }
    private notify(): void {
        this.revision++
        this.changed()
    }
}

export function historyText(text: string, key: string): string {
    return (key ? text.split(key).join('[已脱敏]') : text).slice(0, 12000)
}
