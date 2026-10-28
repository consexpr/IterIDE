import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CppLanguageService } from './index'
import { CLIENT_CAPABILITY } from './semantic'
import { fixture as makeFixture, fakeModel, flush, token } from './test-support'

const services: CppLanguageService[] = []
function fixture(available = true) {
    const result = makeFixture(available)
    services.push(result.service)
    return result
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
    for (const service of services.splice(0)) service.dispose()
    vi.useRealTimers()
})

const pings = (f: ReturnType<typeof fixture>): any[] => f.requests('iter/ping')

describe('clangd health check', () => {
    it('leaves a server that answers alone, even if it answers with an error', async () => {
        const f = fixture(),
            m = fakeModel('int x;')
        f.service.attach(m.model, '/tmp/a.cpp')
        await flush()
        for (let round = 1; round <= 3; round++) {
            await vi.advanceTimersByTimeAsync(15_000)
            expect(pings(f)).toHaveLength(round)
            f.deliver({ jsonrpc: '2.0', id: pings(f).at(-1).id, error: { code: -32601, message: 'method not found' } })
        }
        expect(f.api.lsp.restart).not.toHaveBeenCalled()
    })

    it('restarts a server that stops answering, after two missed checks', async () => {
        const f = fixture(),
            m = fakeModel('int x;')
        f.service.attach(m.model, '/tmp/a.cpp')
        await flush()
        await vi.advanceTimersByTimeAsync(15_000 + 6_000)
        expect(f.api.lsp.restart).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(15_000 + 6_000)
        expect(f.api.lsp.restart).toHaveBeenCalledTimes(1)
    })

    it('one missed check does not count against a server that answers the next one', async () => {
        const f = fixture(),
            m = fakeModel('int x;')
        f.service.attach(m.model, '/tmp/a.cpp')
        await flush()
        await vi.advanceTimersByTimeAsync(15_000 + 6_000) // 21s: first check missed
        await vi.advanceTimersByTimeAsync(9_000) // 30s: next check goes out
        f.deliver({ jsonrpc: '2.0', id: pings(f).at(-1).id, error: {} }) // answered
        await vi.advanceTimersByTimeAsync(15_000 + 6_000) // 51s: missed again, but not consecutively
        expect(f.api.lsp.restart).not.toHaveBeenCalled()
    })

    it('tries again after the automatic retries gave up, at most once a minute', async () => {
        const f = fixture(),
            m = fakeModel('int x;')
        f.api.lsp.restart.mockResolvedValue(false)
        f.service.attach(m.model, '/tmp/a.cpp')
        await flush()
        f.deliver({ jsonrpc: '2.0', method: '$/iter/status', params: { state: 'fallback' } })
        expect(f.service.status()).toBe('fallback')
        await vi.advanceTimersByTimeAsync(60_000)
        expect(f.api.lsp.restart).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(15_000)
        expect(f.api.lsp.restart).toHaveBeenCalledTimes(2)
    })

    it('initialises again when the revival works', async () => {
        const f = fixture(),
            m = fakeModel('int x;')
        f.service.attach(m.model, '/tmp/a.cpp')
        await flush()
        f.deliver({ jsonrpc: '2.0', method: '$/iter/status', params: { state: 'fallback' } })
        await vi.advanceTimersByTimeAsync(15_000)
        await flush()
        expect(f.api.lsp.restart).toHaveBeenCalledTimes(1)
        expect(f.requests('initialize')).toHaveLength(2)
        expect(f.service.status()).toBe('clangd')
    })

    it('does nothing without open files, and stops with the service', async () => {
        const f = fixture()
        await vi.advanceTimersByTimeAsync(120_000)
        expect(pings(f)).toHaveLength(0)
        f.service.dispose()
        expect(f.api.lsp.restart).not.toHaveBeenCalled()
    })
})

describe('semantic highlighting through the language service', () => {
    it('asks clangd for tokens and returns them in the ITER legend', async () => {
        const f = fixture(),
            m = fakeModel('#define ls (n)\nint g;\nint main() { int n; ls; }')
        f.service.attach(m.model, '/tmp/a.cpp')
        await flush()
        expect(f.requests('initialize')[0].params.capabilities.textDocument.semanticTokens).toMatchObject({
            requests: { full: true }
        })
        const types = CLIENT_CAPABILITY.tokenTypes,
            mods = CLIENT_CAPABILITY.tokenModifiers
        const result = f.providers.semantic.provideDocumentSemanticTokens(m.model, null, token)
        await flush()
        const request = f.requests('textDocument/semanticTokens/full')[0]
        expect(request.params.textDocument.uri).toBe('file:///tmp/a.cpp')
        f.respond(request.id, {
            data: [
                0,
                8,
                2,
                types.indexOf('macro'),
                0,
                1,
                4,
                1,
                types.indexOf('variable'),
                1 << mods.indexOf('globalScope')
            ]
        })
        const tokens = await result
        expect(Array.from(tokens.data)).toEqual([0, 8, 2, 5, 0, 1, 4, 1, 8, 0])
        expect(f.providers.semantic.getLegend().tokenTypes[5]).toBe('macro')
    })

    it('returns nothing, and does not ask, while clangd is unavailable', async () => {
        const f = fixture(false),
            m = fakeModel('int x;')
        f.service.attach(m.model, '/tmp/a.cpp')
        await flush()
        expect(await f.providers.semantic.provideDocumentSemanticTokens(m.model, null, token)).toBeNull()
        expect(f.requests('textDocument/semanticTokens/full')).toHaveLength(0)
    })

    it('drops tokens for text that changed while they were being computed', async () => {
        const f = fixture(),
            m = fakeModel('int x;')
        f.service.attach(m.model, '/tmp/a.cpp')
        await flush()
        const result = f.providers.semantic.provideDocumentSemanticTokens(m.model, null, token)
        await flush()
        m.edit('int xy;')
        f.respond(f.requests('textDocument/semanticTokens/full')[0].id, { data: [0, 4, 1, 0, 0] })
        expect(await result).toBeNull()
    })

    it('tells Monaco to ask again once clangd is ready', async () => {
        const f = fixture(),
            m = fakeModel('int x;')
        const changed = vi.fn()
        f.providers.semantic.onDidChange(changed)
        f.service.attach(m.model, '/tmp/a.cpp')
        await flush()
        expect(changed).toHaveBeenCalled()
    })
})
