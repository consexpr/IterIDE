import {
    aiCompletionSettings,
    validInlineRequest,
    type AiCompletionSettings,
    type InlineResult
} from '../../shared/inlineAi'

import { ApiHistory, historyText } from './history'
import type { ApiCallStatus } from '../../shared/apiHistory'

export const FIM_ENDPOINT = 'https://api.deepseek.com/beta/completions'
const TIMEOUT_MS = 10_000
const MAX_TOKENS = 128

type Fetch = (input: string, init: RequestInit) => Promise<Response>

/** Fill-in-the-middle completion: one in-flight request per id, so a newer keystroke cancels the older one. */
export class InlineAiService {
    private readonly active = new Map<string, AbortController>()

    constructor(
        private readonly settings: () => unknown,
        private readonly fetcher: Fetch = (input, init) => fetch(input, init),
        private readonly history = new ApiHistory()
    ) {}

    cancel(id: string): void {
        this.active.get(id)?.abort()
    }

    async complete(request: unknown): Promise<InlineResult> {
        if (!validInlineRequest(request)) return null
        const config: AiCompletionSettings = aiCompletionSettings(this.settings())
        if (!config.enabled) return null
        if (!config.apiKey) return { error: '未填写 API Key' }
        this.cancel(request.id)
        const controller = new AbortController()
        this.active.set(request.id, controller)
        const startedAt = Date.now()
        const safe = (text: string): string => historyText(text, config.apiKey)
        const historyId = this.history.start({
            startedAt,
            durationMs: 0,
            status: 'pending',
            model: safe(config.model),
            effort: safe(config.effort),
            endpoint: FIM_ENDPOINT,
            prefix: safe(request.prefix),
            suffix: safe(request.suffix),
            output: '',
            error: ''
        })
        let status: ApiCallStatus = 'error'
        let output = '',
            detail = ''
        let httpStatus: number | undefined
        let timedOut = false
        const timer = setTimeout(() => {
            timedOut = true
            controller.abort()
        }, TIMEOUT_MS)
        try {
            const response = await this.fetcher(FIM_ENDPOINT, {
                method: 'POST',
                signal: controller.signal,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
                body: JSON.stringify({
                    model: config.model,
                    prompt: request.prefix,
                    suffix: request.suffix,
                    max_tokens: MAX_TOKENS,
                    temperature: 0,
                    ...(config.effort && { reasoning_effort: config.effort })
                })
            })
            httpStatus = response.status
            if (controller.signal.aborted) return null
            if (!response.ok) {
                detail = safe(await failure(response))
                return { error: detail }
            }
            const body = (await response.json()) as { choices?: { text?: unknown }[] }
            const text = body.choices?.[0]?.text
            if (controller.signal.aborted) return null
            if (typeof text !== 'string') {
                detail = '响应中缺少补全文本'
                return null
            }
            status = 'success'
            output = safe(text)
            return { text }
        } catch (error) {
            if (controller.signal.aborted) return null
            detail = safe(error instanceof Error ? error.message : String(error))
            return { error: detail }
        } finally {
            clearTimeout(timer)
            if (controller.signal.aborted) status = timedOut ? 'timeout' : 'cancelled'
            this.history.finish(historyId, {
                status,
                durationMs: Date.now() - startedAt,
                output,
                error: detail,
                httpStatus
            })
            if (this.active.get(request.id) === controller) this.active.delete(request.id)
        }
    }
}

async function failure(response: Response): Promise<string> {
    let detail = ''
    try {
        const body = (await response.json()) as { error?: { message?: string } }
        detail = body.error?.message ?? ''
    } catch {
        /* Not JSON. */
    }
    return `DeepSeek ${response.status}${detail ? `：${detail}` : ''}`
}
