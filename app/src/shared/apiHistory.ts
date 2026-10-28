export type ApiCallStatus = 'pending' | 'success' | 'error' | 'cancelled' | 'timeout'
export interface ApiCall {
    id: string
    startedAt: number
    durationMs: number
    status: ApiCallStatus
    model: string
    effort: string
    endpoint: string
    prefix: string
    suffix: string
    output: string
    error: string
    httpStatus?: number
}
export interface ApiHistoryState {
    revision: number
    records: ApiCall[]
}
export const API_HISTORY_LIMIT = 200
