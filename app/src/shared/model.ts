/** Only ranking inputs cross IPC. Edits, snippets and commands stay with clangd. */
export interface ModelCandidate {
    label: string
    kind?: number
    filterText?: string
    detail?: string
    labelDetails?: { detail?: string }
    score?: number
}
export interface ModelRequest {
    id: string
    source: string
    cursor: number // UTF-16 offset, matching Monaco.
    prefix: string
    standard: string
    candidates: ModelCandidate[]
}
export interface ModelResult {
    order: number[] // Original candidate indices, highest probability first.
    probabilities: number[] // Indexed by original candidate index.
}
export const MODEL_REQUEST_TIMEOUT_MS = 120
export const MODEL_MAX_SOURCE_BYTES = 256 * 1024

export function validModelRequest(value: unknown): value is ModelRequest {
    if (!value || typeof value !== 'object') return false
    const request = value as ModelRequest
    return (
        typeof request.id === 'string' &&
        request.id.length <= 128 &&
        typeof request.source === 'string' &&
        request.source.length <= MODEL_MAX_SOURCE_BYTES &&
        !request.source.includes('\0') &&
        Number.isInteger(request.cursor) &&
        request.cursor >= 0 &&
        request.cursor <= request.source.length &&
        typeof request.prefix === 'string' &&
        request.prefix.length <= 512 &&
        /^(?:gnu|c)\+\+(?:98|11|14|17|20|23|26)$/.test(request.standard) &&
        Array.isArray(request.candidates) &&
        request.candidates.length >= 1 &&
        request.candidates.length <= 100 &&
        request.candidates.every(
            (item) =>
                item &&
                typeof item.label === 'string' &&
                item.label.length <= 4096 &&
                (item.filterText === undefined ||
                    (typeof item.filterText === 'string' && item.filterText.length <= 4096)) &&
                (item.detail === undefined || (typeof item.detail === 'string' && item.detail.length <= 8192)) &&
                (item.kind === undefined || (Number.isInteger(item.kind) && item.kind >= 0 && item.kind <= 25)) &&
                (item.score === undefined || (typeof item.score === 'number' && Number.isFinite(item.score))) &&
                (item.labelDetails === undefined ||
                    (item.labelDetails &&
                        typeof item.labelDetails === 'object' &&
                        (item.labelDetails.detail === undefined ||
                            (typeof item.labelDetails.detail === 'string' && item.labelDetails.detail.length <= 4096))))
        )
    )
}

export function validModelResult(result: ModelResult | null | undefined, count: number): result is ModelResult {
    return (
        !!result &&
        Array.isArray(result.order) &&
        result.order.length === count &&
        new Set(result.order).size === count &&
        result.order.every((i) => Number.isInteger(i) && i >= 0 && i < count) &&
        Array.isArray(result.probabilities) &&
        result.probabilities.length === count &&
        result.probabilities.every((p) => Number.isFinite(p) && p >= 0 && p <= 1) &&
        Math.abs(result.probabilities.reduce((sum, p) => sum + p, 0) - 1) < 0.0001
    )
}
