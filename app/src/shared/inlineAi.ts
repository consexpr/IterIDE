/** Inline (ghost text) completion through DeepSeek's FIM endpoint. The key is kept as plain settings. */
export interface AiCompletionSettings {
    enabled: boolean
    apiKey: string
    /** Free text: any model id the endpoint accepts. */
    model: string
    /** Free text, sent as `reasoning_effort` when not empty. */
    effort: string
}

export const DEFAULT_AI_COMPLETION: Readonly<AiCompletionSettings> = {
    enabled: false,
    apiKey: '',
    model: 'deepseek-flash',
    effort: ''
}

export function aiCompletionSettings(value: unknown): AiCompletionSettings {
    const v = (value && typeof value === 'object' ? value : {}) as Partial<AiCompletionSettings>
    const text = (x: unknown, fallback: string): string => (typeof x === 'string' ? x.trim() : fallback)
    return {
        enabled: v.enabled === true,
        apiKey: text(v.apiKey, ''),
        model: text(v.model, DEFAULT_AI_COMPLETION.model) || DEFAULT_AI_COMPLETION.model,
        effort: text(v.effort, '')
    }
}

export interface InlineRequest {
    id: string
    /** Code before the cursor / after it, already trimmed to a window. */
    prefix: string
    suffix: string
}

export const INLINE_MAX_PREFIX = 8000
export const INLINE_MAX_SUFFIX = 3000

export function validInlineRequest(value: unknown): value is InlineRequest {
    if (!value || typeof value !== 'object') return false
    const r = value as InlineRequest
    return (
        typeof r.id === 'string' &&
        r.id.length <= 128 &&
        typeof r.prefix === 'string' &&
        r.prefix.length <= INLINE_MAX_PREFIX &&
        typeof r.suffix === 'string' &&
        r.suffix.length <= INLINE_MAX_SUFFIX
    )
}

/** What the model returned, or why nothing could be asked for. */
export type InlineResult = { text: string } | { error: string } | null
