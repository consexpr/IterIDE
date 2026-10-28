import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeModel, fixture, flush, token } from './test-support'
import type { CppLanguageService } from './index'
import type { ModelResult } from '../../shared/model'

const services: CppLanguageService[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
    services.splice(0).forEach((service) => service.dispose())
    vi.useRealTimers()
})
async function setup(enabled = true) {
    const f = fixture(),
        model = fakeModel('qu')
    services.push(f.service)
    f.settings.completion = { model: enabled, sortByScope: false, recordUsage: false }
    f.api.model.rank.mockResolvedValue({ order: [1, 0], probabilities: [0.2, 0.8] })
    f.service.attach(model.model, 'D:/isolated/a.cpp')
    await flush()
    const items = [
        { label: 'query(int x)', kind: 3, sortText: '1', detail: 'long long' },
        { label: 'queryEmpty()', kind: 3, sortText: '2', detail: 'bool' }
    ]
    const provide = () => {
        const pending = f.providers.completion.provideCompletionItems(model.model, model.position(), {}, token)
        const request = f.requests('textDocument/completion').at(-1)
        if (request) f.respond(request.id, { items })
        return pending
    }
    return { f, model, items, provide }
}

describe('Model completion toggle and semantic edit preservation', () => {
    it('keeps existing ranking when disabled without invoking the model', async () => {
        const { f, provide } = await setup(false)
        expect((await provide()).suggestions.map((item: any) => item.label)).toEqual(['query', 'queryEmpty'])
        expect(f.api.model.rank).not.toHaveBeenCalled()
    })

    it('reorders with Model while preserving parameter and zero-argument cursor placement', async () => {
        const { f, provide, items } = await setup()
        const before = structuredClone(items)
        const result = await provide()
        expect(result.suggestions.map((item: any) => [item.label, item.insertText])).toEqual([
            ['queryEmpty', 'queryEmpty()$0'],
            ['query', 'query($0)']
        ])
        expect(items).toEqual(before)
        expect(f.api.model.rank.mock.calls[0][0]).toMatchObject({ source: 'qu', cursor: 2, prefix: 'qu' })
    })

    it('keeps the model order while the same word is extended and asks again when its favourite is gone', async () => {
        const { f, model, items, provide } = await setup()
        expect((await provide()).suggestions.map((item: any) => item.label)).toEqual(['queryEmpty', 'query'])
        expect(f.api.model.rank).toHaveBeenCalledTimes(1)
        model.edit('que')
        expect((await provide()).suggestions.map((item: any) => item.label)).toEqual(['queryEmpty', 'query'])
        model.edit('queryE')
        expect((await provide()).suggestions.map((item: any) => item.label)).toEqual(['queryEmpty'])
        expect(f.api.model.rank).toHaveBeenCalledTimes(1)
        // The favourite ("queryEmpty") no longer matches: that is new information for the model.
        model.edit('query(')
        model.edit('queryx')
        items.splice(
            0,
            items.length,
            { label: 'queryxa()', kind: 3, sortText: '1', detail: 'int' },
            { label: 'queryxb()', kind: 3, sortText: '2', detail: 'int' }
        )
        await provide()
        expect(f.api.model.rank).toHaveBeenCalledTimes(2)
    })

    it('asks the model again when the text around the word changes', async () => {
        const { f, model, provide } = await setup()
        await provide()
        model.edit('x qu')
        await provide()
        expect(f.api.model.rank).toHaveBeenCalledTimes(2)
    })

    it('falls back on rejection, malformed output and timeout', async () => {
        const { f, provide } = await setup()
        f.api.model.rank.mockRejectedValueOnce(Error('unavailable'))
        expect((await provide()).suggestions[0].label).toBe('query')
        f.api.model.rank.mockResolvedValueOnce({ order: [0, 0], probabilities: [0.5, 0.5] })
        expect((await provide()).suggestions[0].label).toBe('query')
        f.api.model.rank.mockImplementationOnce(() => new Promise(() => {}))
        const pending = provide()
        await flush()
        await vi.advanceTimersByTimeAsync(140)
        expect((await pending).suggestions[0].label).toBe('query')
        expect(f.api.model.cancel).toHaveBeenCalled()
    })

    it('drops late inference after editing and uses baseline when switched off while pending', async () => {
        const { f, model, provide } = await setup()
        let complete!: (result: ModelResult) => void
        f.api.model.rank.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    complete = resolve
                })
        )
        const pending = provide()
        await flush()
        model.edit('qux')
        complete({ order: [1, 0], probabilities: [0.2, 0.8] })
        expect((await pending).suggestions).toEqual([])
        model.edit(' qu')
        f.api.model.rank.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    complete = resolve
                })
        )
        const switched = provide()
        await flush()
        f.settings.completion = { ...f.settings.completion, model: false }
        complete({ order: [1, 0], probabilities: [0.2, 0.8] })
        expect((await switched).suggestions[0].label).toBe('query')
    })

    it('rejects the older request even when the document version and cursor did not change', async () => {
        const { f, provide } = await setup()
        let complete!: (result: ModelResult) => void
        f.api.model.rank.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    complete = resolve
                })
        )
        const older = provide()
        await flush()
        const newer = await provide()
        complete({ order: [1, 0], probabilities: [0.2, 0.8] })
        expect(newer.suggestions[0].label).toBe('queryEmpty')
        expect((await older).suggestions).toEqual([])
        expect((f.api.model.rank.mock.calls[0][0] as any).id).not.toBe((f.api.model.rank.mock.calls[1][0] as any).id)
    })
})
