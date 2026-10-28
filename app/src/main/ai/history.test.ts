import { describe, it, expect, vi } from 'vitest'
import { ApiHistory, historyText } from './history'
import { InlineAiService } from './inline'
import { API_HISTORY_LIMIT } from '../../shared/apiHistory'
const config = { enabled: true, apiKey: 'test-secret', model: 'test', effort: '' }
const request = { id: 'slot', prefix: 'test-secret prefix', suffix: 'suffix' }
const reply = () => new Response(JSON.stringify({ choices: [{ text: 'test-secret output' }] }))
const pendingFetch = (_url: string, init: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))))

describe('API call history', () => {
    it('records independent calls and redacts credentials across context and output', async () => {
        const history = new ApiHistory()
        const service = new InlineAiService(
            () => config,
            async () => reply(),
            history
        )
        await service.complete(request)
        await service.complete(request)
        const state = history.snapshot()
        expect(state.records).toHaveLength(2)
        expect(state.records[0].id).not.toBe(state.records[1].id)
        expect(state.records[0]).toMatchObject({ status: 'success', httpStatus: 200 })
        expect(JSON.stringify(state)).not.toContain(config.apiKey)
        state.records[0].output = 'changed'
        expect(history.snapshot().records[0].output).not.toBe('changed')
    })
    it('does not resurrect deleted or cleared requests when they finish', async () => {
        const history = new ApiHistory()
        let resolve!: (response: Response) => void
        const service = new InlineAiService(
            () => config,
            () =>
                new Promise((done) => {
                    resolve = done
                }),
            history
        )
        const first = service.complete(request)
        history.delete(history.snapshot().records[0].id)
        resolve(reply())
        await first
        expect(history.snapshot().records).toEqual([])
        const second = service.complete(request)
        history.clear()
        resolve(reply())
        await second
        expect(history.snapshot().records).toEqual([])
    })
    it('distinguishes manual cancellation and timeout', async () => {
        vi.useFakeTimers()
        try {
            const history = new ApiHistory()
            const service = new InlineAiService(() => config, pendingFetch, history)
            const cancelled = service.complete(request)
            service.cancel(request.id)
            await cancelled
            expect(history.snapshot().records[0].status).toBe('cancelled')
            const timeout = service.complete(request)
            await vi.advanceTimersByTimeAsync(10000)
            await timeout
            expect(history.snapshot().records[0].status).toBe('timeout')
        } finally {
            vi.useRealTimers()
        }
    })
    it('retains errors without keys and bounds retained history', async () => {
        const history = new ApiHistory()
        const service = new InlineAiService(
            () => config,
            async () => {
                throw new Error(config.apiKey)
            },
            history
        )
        for (let i = 0; i < API_HISTORY_LIMIT + 2; i++) await service.complete(request)
        expect(history.snapshot().records).toHaveLength(API_HISTORY_LIMIT)
        expect(history.snapshot().records.every((record) => record.status === 'error')).toBe(true)
        expect(JSON.stringify(history.snapshot())).not.toContain(config.apiKey)
        expect(historyText('a'.repeat(20000), '')).toHaveLength(12000)
    })
})
