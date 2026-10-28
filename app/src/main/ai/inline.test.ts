import { describe, expect, it, vi } from 'vitest'
import { FIM_ENDPOINT, InlineAiService } from './inline'

const enabled = { enabled: true, apiKey: ' sk-test ', model: 'deepseek-flash', effort: '' }
const reply = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const request = { id: 'a', prefix: 'int main() {\n    ', suffix: '\n}' }

describe('InlineAiService', () => {
    it('sends prompt and suffix to the FIM endpoint with the key', async () => {
        const fetcher = vi.fn(async () => reply({ choices: [{ text: 'return 0;' }] }))
        const service = new InlineAiService(() => enabled, fetcher)
        expect(await service.complete(request)).toEqual({ text: 'return 0;' })
        const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
        expect(url).toBe(FIM_ENDPOINT)
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
        expect(JSON.parse(init.body as string)).toMatchObject({
            model: 'deepseek-flash',
            prompt: request.prefix,
            suffix: request.suffix
        })
        expect(JSON.parse(init.body as string)).not.toHaveProperty('reasoning_effort')
    })

    it('sends effort only when it is filled in', async () => {
        const fetcher = vi.fn(async () => reply({ choices: [{ text: 'x' }] }))
        await new InlineAiService(() => ({ ...enabled, effort: 'high' }), fetcher).complete(request)
        expect(
            JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).reasoning_effort
        ).toBe('high')
    })

    it('does nothing while disabled and reports a missing key', async () => {
        const fetcher = vi.fn()
        expect(await new InlineAiService(() => ({ ...enabled, enabled: false }), fetcher).complete(request)).toBeNull()
        expect(await new InlineAiService(() => ({ ...enabled, apiKey: '' }), fetcher).complete(request)).toEqual({
            error: '未填写 API Key'
        })
        expect(fetcher).not.toHaveBeenCalled()
    })

    it('reports HTTP failures and rejects malformed requests', async () => {
        const service = new InlineAiService(
            () => enabled,
            async () => reply({ error: { message: 'Authentication Fails' } }, 401)
        )
        expect(await service.complete(request)).toEqual({ error: 'DeepSeek 401：Authentication Fails' })
        expect(await service.complete({ id: 1 })).toBeNull()
    })

    it('aborts the older request for the same id', async () => {
        let signal: AbortSignal | undefined
        const fetcher = vi.fn((_url: string, init: RequestInit) => {
            signal ??= init.signal as AbortSignal
            return new Promise<Response>((_resolve, reject) =>
                init.signal!.addEventListener('abort', () => reject(new Error('aborted')))
            )
        })
        const service = new InlineAiService(() => enabled, fetcher)
        const first = service.complete(request)
        void service.complete(request)
        expect(await first).toBeNull()
        expect(signal!.aborted).toBe(true)
        service.cancel('a')
    })
})
