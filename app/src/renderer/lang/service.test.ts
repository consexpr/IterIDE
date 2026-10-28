import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CppLanguageService } from './index'
import { fixture as makeFixture, fakeModel, flush, token } from './test-support'

function fixture(available = true) {
    const result = makeFixture(available)
    services.push(result.service)
    return result
}

const services: CppLanguageService[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
    for (const service of services.splice(0)) service.dispose()
    vi.useRealTimers()
})

describe('Monaco language service lifecycle', () => {
    it('initializes, opens, sends descending incremental edits, renames and disposes', async () => {
        const f = fixture(),
            m = fakeModel('ab cd')
        const statuses: string[] = []
        const unsubscribe = f.service.onStatus((status) => statuses.push(status))
        f.service.attach(m.model, 'D:\\CP\\a.cpp')
        await flush()
        expect(f.service.status()).toBe('clangd')
        expect(statuses).toEqual(['starting', 'clangd'])
        expect(f.requests('textDocument/didOpen')[0].params.textDocument).toMatchObject({
            uri: 'file:///D:/CP/a.cpp',
            version: 1,
            text: 'ab cd'
        })
        expect(f.requests('workspace/didChangeConfiguration')[0].params.settings.iter.flags).toBe('-std=c++20')
        m.edit('Ab Cd', [
            {
                rangeOffset: 0,
                rangeLength: 1,
                text: 'A',
                range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }
            },
            {
                rangeOffset: 3,
                rangeLength: 1,
                text: 'C',
                range: { startLineNumber: 1, startColumn: 4, endLineNumber: 1, endColumn: 5 }
            }
        ])
        expect(f.requests('textDocument/didChange')[0].params).toMatchObject({
            textDocument: { version: 2 },
            contentChanges: [{ text: 'C', range: { start: { line: 0, character: 3 } } }, { text: 'A' }]
        })
        const rename = f.service.rename
        rename(m.model, 'D:\\CP\\b.cpp')
        expect(f.requests('textDocument/didClose')[0].params.textDocument.uri).toBe('file:///D:/CP/a.cpp')
        expect(f.requests('textDocument/didOpen').at(-1).params.textDocument.uri).toBe('file:///D:/CP/b.cpp')
        m.dispose()
        expect(f.requests('textDocument/didClose')).toHaveLength(2)
        unsubscribe()
        f.service.dispose()
        expect(f.registrations.every((registration) => registration.dispose.mock.calls.length === 1)).toBe(true)
        expect(f.listeners.size).toBe(0)
    })

    it('waits 150ms, retains late semantics, uses incomplete refresh and cancels stale completion', async () => {
        const f = fixture(),
            m = fakeModel('sor')
        f.service.attach(m.model, '/tmp/a.cpp')
        await flush()
        const resultPromise = f.providers.completion.provideCompletionItems(m.model, m.position(), {}, token)
        let finished = false
        void resultPromise.then(() => {
            finished = true
        })
        await vi.advanceTimersByTimeAsync(149)
        expect(finished).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        const result = await resultPromise
        expect(result.incomplete).toBe(true)
        expect(result.suggestions).toEqual([])
        f.respond(f.requests('textDocument/completion').at(-1).id, {
            items: [{ label: 'sort(Iterator first, Iterator last)', kind: 3, detail: 'void' }]
        })
        await flush()
        const cached = await f.providers.completion.provideCompletionItems(m.model, m.position(), {}, token)
        expect(cached.suggestions[0].insertText).toBe('sort($0)')
        m.edit('sort')
        const stale = f.providers.completion.provideCompletionItems(m.model, m.position(), {}, token)
        const id = f.requests('textDocument/completion').at(-1).id
        m.edit('sortx')
        await flush()
        expect(f.requests('$/cancelRequest').some((message) => message.params.id === id)).toBe(true)
        expect((await stale).suggestions).toEqual([])
    })

    it('warms clangd with one completion at the end of the file right after didOpen', async () => {
        const f = fixture(),
            m = fakeModel(['#include <bits/stdc++.h>', 'int main() {', '}', ''].join('\n'))
        f.service.attach(m.model, '/tmp/a.cpp')
        await flush()
        const warm = f.requests('textDocument/completion')
        expect(f.requests('textDocument/didOpen')).toHaveLength(1)
        expect(warm).toHaveLength(1)
        expect(warm[0].params.position).toEqual({ line: 3, character: 0 })
    })

    it('re-opens the suggest list when clangd answers after the budget and the cursor has not moved', async () => {
        const f = fixture(),
            m = fakeModel('ios::sync_with_')
        const trigger = vi.fn(),
            position = { lineNumber: 1, column: 16 }
        const editor = { getModel: () => m.model, hasTextFocus: () => true, getPosition: () => position, trigger }
        f.editors.push(editor)
        f.service.attach(m.model, '/tmp/a.cpp')
        await flush()
        const pending = f.providers.completion.provideCompletionItems(m.model, m.position(), {}, token)
        await vi.advanceTimersByTimeAsync(150)
        expect((await pending).suggestions).toEqual([])
        f.respond(f.requests('textDocument/completion').at(-1).id, {
            items: [{ label: ' sync_with_stdio(bool sync = true)', kind: 2, filterText: 'sync_with_stdio' }]
        })
        await flush()
        expect(trigger).toHaveBeenCalledWith('iter.completion', 'editor.action.triggerSuggest', {})
        const again = await f.providers.completion.provideCompletionItems(m.model, m.position(), {}, token)
        expect(again.suggestions.map((item: any) => item.label)).toEqual(['sync_with_stdio'])

        trigger.mockClear()
        position.column = 3
        m.edit('ios::sync_with_x')
        const moved = f.providers.completion.provideCompletionItems(m.model, m.position(), {}, token)
        await vi.advanceTimersByTimeAsync(150)
        await moved
        f.respond(f.requests('textDocument/completion').at(-1).id, { items: [] })
        await flush()
        expect(trigger).not.toHaveBeenCalled()
    })

    it('waits for member results and keeps real members authoritative', async () => {
        const f = fixture(),
            m = fakeModel('v.pu')
        f.service.attach(m.model, '/tmp/a.cpp')
        await flush()
        const pending = f.providers.completion.provideCompletionItems(m.model, m.position(), {}, token)
        await vi.advanceTimersByTimeAsync(100)
        f.respond(f.requests('textDocument/completion').at(-1).id, {
            items: [
                { label: 'push_back(const int &value)', kind: 2, detail: 'void' },
                { label: '_M_impl', kind: 5 }
            ]
        })
        const result = await pending
        expect(result.suggestions.map((item: any) => item.label)).toEqual(['push_back'])
        expect(result.suggestions[0]).toMatchObject({ insertText: 'push_back($0)', insertTextRules: 4 })
        expect(result.suggestions[0].range).toMatchObject({ startColumn: 3, endColumn: 5 })
        expect(
            (await f.providers.completion.provideCompletionItems(m.model, m.position(), {}, token)).suggestions.map(
                (item: any) => item.label
            )
        ).toEqual(['push_back'])
    })

    it('disables clangd snippets, records acceptance only and exits a previous snippet session', async () => {
        const f = fixture(),
            m = fakeModel('sor')
        const editor = {
            hasTextFocus: () => true,
            getModel: () => m.model,
            getSelections: () => null,
            getContribution: () => ({ isInSnippet: () => true }),
            trigger: vi.fn()
        }
        f.editors.push(editor)
        f.service.attach(m.model, '/tmp/a.cpp')
        await flush()
        expect(
            f.requests('initialize')[0].params.capabilities.textDocument.completion.completionItem.snippetSupport
        ).toBe(false)
        const pending = f.providers.completion.provideCompletionItems(m.model, m.position(), {}, token)
        f.respond(f.requests('textDocument/completion').at(-1).id, {
            items: [
                { label: 'sort', kind: 3, insertTextFormat: 2, insertText: 'sort(${1:first}, ${1:first}, ${2:last})$0' }
            ]
        })
        const result = await pending,
            item = result.suggestions[0]
        expect(item.insertText).toBe('sort($0)')
        expect(f.service.exportUsage()).toEqual({})
        f.commands.get(item.command.id)!(null, ...item.command.arguments)
        expect(f.service.exportUsage()).toEqual({ 'function:sort': 1 })
        expect(editor.trigger).toHaveBeenCalledWith('iter.cpp.completion', 'leaveSnippet', {})
        f.settings.completion = { recordUsage: false }
        f.commands.get(item.command.id)!(null, ...item.command.arguments)
        expect(f.service.exportUsage()).toEqual({ 'function:sort': 1 })
        editor.trigger.mockClear()
        editor.getContribution = () => ({ isInSnippet: () => false })
        f.commands.get(item.command.id)!(null, ...item.command.arguments)
        expect(editor.trigger).not.toHaveBeenCalled()
        f.service.importUsage({ 'function:sort': 4 })
        expect(f.service.exportUsage()).toEqual({ 'function:sort': 4 })
    })

    it.each([
        { text: 'qu', kind: 3, appendFunc: true, signature: undefined, tracked: true },
        { text: 'qu', kind: 3, appendFunc: true, signature: '()', tracked: false },
        { text: 'qu', kind: 3, appendFunc: false, signature: undefined, tracked: false },
        { text: 'qu()', kind: 3, appendFunc: true, signature: undefined, tracked: false },
        { text: 'qu', kind: 6, appendFunc: true, signature: undefined, tracked: false }
    ])('only tracks newly appended callable pairs: %j', async ({ text, kind, appendFunc, signature, tracked }) => {
        const f = fixture(),
            m = fakeModel(text)
        f.settings.completion = { appendFunc }
        f.service.attach(m.model, '/tmp/brackets.cpp')
        await flush()
        const pending = f.providers.completion.provideCompletionItems(m.model, { lineNumber: 1, column: 3 }, {}, token)
        f.respond(f.requests('textDocument/completion').at(-1).id, {
            items: [{ label: 'query', kind, labelDetails: { detail: signature } }]
        })
        const result = await pending
        expect(result.suggestions).toHaveLength(1)
        expect(!!result.suggestions[0].command.arguments[3]).toBe(tracked)
    })

    it('enforces contexts, min characters, keyword settings and manual completion when typing is disabled', async () => {
        const f = fixture(false),
            m = fakeModel('// comment ve')
        f.service.attach(m.model, '/tmp/a.cpp')
        await flush()
        const complete = (triggerKind = 0) =>
            f.providers.completion.provideCompletionItems(m.model, m.position(), { triggerKind }, token)
        expect((await complete()).suggestions).toEqual([])
        m.edit('int main() {\nfo')
        expect((await complete()).suggestions.some((item: any) => item.label === 'for')).toBe(true)
        f.settings.completion = { minCharRequired: 3 }
        expect((await complete()).suggestions).toEqual([])
        f.settings.completion = { showKeywords: false }
        expect((await complete()).suggestions).toEqual([])
        f.settings.completion = { showCompletionWhileInput: false }
        expect((await complete(1)).suggestions).toEqual([])
        expect((await complete(0)).suggestions.some((item: any) => item.label === 'for')).toBe(true)
        for (const text of ['x.fo', '#include<vec', '"fo']) {
            m.edit(text)
            expect((await complete()).suggestions).toEqual([])
        }
    })

    it('maps current diagnostics, ignores old versions, and clears them when disabled', async () => {
        const f = fixture(),
            m = fakeModel('int x;')
        f.service.attach(m.model, '/tmp/a.cpp')
        await flush()
        const publish = (version: number) =>
            f.deliver({
                method: 'textDocument/publishDiagnostics',
                params: {
                    uri: 'file:///tmp/a.cpp',
                    version,
                    diagnostics: [
                        {
                            range: { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } },
                            severity: 2,
                            message: 'warning'
                        }
                    ]
                }
            })
        publish(1)
        expect(f.markers.mock.calls.at(-1)?.[2][0]).toMatchObject({
            severity: 4,
            startLineNumber: 1,
            startColumn: 3,
            endColumn: 6
        })
        m.edit('int y;')
        const count = f.markers.mock.calls.length
        publish(1)
        expect(f.markers.mock.calls.length).toBe(count)
        f.settings.liveDiagnostics = false
        await vi.advanceTimersByTimeAsync(250)
        expect(f.markers.mock.calls.at(-1)?.[2]).toEqual([])
        publish(2)
        expect(f.markers.mock.calls.at(-1)?.[2]).toEqual([])
        f.settings.liveDiagnostics = true
        await vi.advanceTimersByTimeAsync(250)
        expect(f.markers.mock.calls.at(-1)?.[2][0].message).toBe('warning')
    })

    it('debounces fallback diagnostics, rejects stale work, and tolerates missing IPC', async () => {
        const f = fixture(false),
            m = fakeModel('int x = ;')
        f.service.attach(m.model, '/tmp/a.cpp')
        await flush()
        expect(f.service.status()).toBe('fallback')
        let resolveCheck!: (value: any[]) => void
        f.api.judge.syntaxCheck.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveCheck = resolve
                })
        )
        await vi.advanceTimersByTimeAsync(699)
        expect(f.api.judge.syntaxCheck).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        m.edit('int x = 1;')
        resolveCheck([{ line: 1, column: 9, severity: 'error', message: 'old error' }])
        await flush()
        expect(f.markers.mock.calls.some((call) => call[2].some((marker: any) => marker.message === 'old error'))).toBe(
            false
        )
        f.api.judge.syntaxCheck.mockRejectedValueOnce(new Error('missing handler'))
        await vi.advanceTimersByTimeAsync(700)
        expect(f.api.judge.syntaxCheck).toHaveBeenLastCalledWith('/tmp/a.cpp', 'int x = 1;')
        f.settings.liveDiagnostics = false
        m.edit('int x = ;')
        await vi.advanceTimersByTimeAsync(1000)
        expect(f.api.judge.syntaxCheck).toHaveBeenCalledTimes(2)
        const completion = await f.providers.completion.provideCompletionItems(
            m.model,
            { lineNumber: 1, column: 3 },
            {},
            token
        )
        expect(completion.suggestions.some((item: any) => item.label === 'int')).toBe(true)
    })

    it('reinitializes and reopens current text after a crash; updates flags and hover suppression', async () => {
        const f = fixture(),
            m = fakeModel('int value;')
        f.service.attach(m.model, '/tmp/a.cpp')
        await flush()
        f.deliver({ method: '$/iter/status', params: { state: 'starting' } })
        expect(f.service.status()).toBe('starting')
        m.edit('int changed;')
        f.deliver({ method: '$/iter/status', params: { state: 'restarted' } })
        await flush()
        expect(f.requests('initialize')).toHaveLength(2)
        expect(f.requests('textDocument/didOpen').at(-1).params.textDocument.text).toBe('int changed;')
        expect(f.service.status()).toBe('clangd')
        f.settings.flags = '-std=c++17 -DTEST'
        await vi.advanceTimersByTimeAsync(250)
        expect(f.requests('workspace/didChangeConfiguration').at(-1).params.settings.iter.flags).toBe(
            '-std=c++17 -DTEST'
        )
        f.service.setHoverEnabled(false)
        expect(await f.providers.hover.provideHover(m.model, m.position(), token)).toBeNull()
        expect(f.requests('textDocument/hover')).toHaveLength(0)
        f.service.setHoverEnabled(true)
        const pending = f.providers.hover.provideHover(m.model, m.position(), token)
        f.service.setHoverEnabled(false)
        expect(await pending).toBeNull()
        expect(f.requests('$/cancelRequest').at(-1).params.id).toBe(f.requests('textDocument/hover').at(-1).id)
    })

    it('maps highlights, formatting edits and within-file definitions into Monaco coordinates', async () => {
        const f = fixture(),
            m = fakeModel('int value;')
        f.service.attach(m.model, '/tmp/a.cpp')
        await flush()
        const range = { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } }
        const highlights = f.providers.highlights.provideDocumentHighlights(m.model, m.position(), token)
        f.respond(f.requests('textDocument/documentHighlight').at(-1).id, [{ range, kind: 3 }])
        expect(await highlights).toEqual([
            { range: { startLineNumber: 1, startColumn: 5, endLineNumber: 1, endColumn: 10 }, kind: 2 }
        ])
        const format = f.providers.format.provideDocumentFormattingEdits(
            m.model,
            { tabSize: 4, insertSpaces: true },
            token
        )
        f.respond(f.requests('textDocument/formatting').at(-1).id, [{ range, newText: 'other' }])
        expect((await format)[0]).toMatchObject({ text: 'other', range: { startColumn: 5 } })
        expect(f.api.format.run).not.toHaveBeenCalled()
        const definitions = f.providers.definition.provideDefinition(m.model, m.position(), token)
        f.respond(f.requests('textDocument/definition').at(-1).id, [
            { uri: 'file:///tmp/a.cpp', range },
            { uri: 'file:///usr/include/vector', range }
        ])
        expect(await definitions).toEqual([
            { uri: m.model.uri, range: { startLineNumber: 1, startColumn: 5, endLineNumber: 1, endColumn: 10 } }
        ])
    })

    it('formats offline documents and selections, surfaces errors and ignores stale results', async () => {
        const f = fixture(false),
            m = fakeModel('int  x;')
        f.service.attach(m.model, '/tmp/a.cpp')
        await flush()
        const options = { tabSize: 4, insertSpaces: true }
        expect(await f.providers.format.provideDocumentFormattingEdits(m.model, options, token)).toHaveLength(1)
        const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 8 }
        await f.providers.rangeFormat.provideDocumentRangeFormattingEdits(m.model, range, options, token)
        expect(f.api.format.run).toHaveBeenLastCalledWith('/tmp/a.cpp', 'int  x;', range)
        f.api.format.run.mockResolvedValueOnce({ error: 'missing clang-format' })
        await expect(f.service.format(m.model)).rejects.toThrow('missing clang-format')
        let finish!: (value: { text: string }) => void
        f.api.format.run.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve
                })
        )
        const stale = f.service.format(m.model)
        m.edit('int y;')
        finish({ text: 'int x;\n' })
        expect(await stale).toEqual([])
    })

    it.each([false, true])('discards formatting after indentation settings change (clangd=%s)', async (available) => {
        const f = fixture(available),
            m = fakeModel('int  x;')
        f.service.attach(m.model, '/tmp/a.cpp')
        await flush()
        let finish!: (value: { text: string }) => void
        if (!available)
            f.api.format.run.mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        finish = resolve
                    })
            )
        const pending = f.service.format(m.model)
        const previous = m.model.getOptions()
        vi.spyOn(m.model, 'getOptions').mockImplementation(
            () =>
                new Proxy(previous, {
                    get: (target, key) => (key === 'tabSize' || key === 'indentSize' ? 2 : Reflect.get(target, key))
                })
        )
        if (available)
            f.respond(f.requests('textDocument/formatting').at(-1).id, [
                {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } },
                    newText: 'int x;\n'
                }
            ])
        else finish({ text: 'int x;\n' })
        expect(await pending).toEqual([])
        expect(m.model.getVersionId()).toBe(1)
    })

    it('uses clangd range formatting, falls back after an RPC failure and respects cancellation', async () => {
        const f = fixture(),
            m = fakeModel('int  x;')
        f.service.attach(m.model, '/tmp/a.cpp')
        await flush()
        const options = { tabSize: 4, insertSpaces: true },
            range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 8 }
        const pending = f.providers.rangeFormat.provideDocumentRangeFormattingEdits(m.model, range, options, token)
        const request = f.requests('textDocument/rangeFormatting').at(-1)
        expect(request.params).toMatchObject({
            iterSource: 'int  x;',
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } }
        })
        f.deliver({ jsonrpc: '2.0', id: request.id, error: { code: -1, message: 'unavailable' } })
        expect(await pending).toHaveLength(1)
        expect(f.api.format.run).toHaveBeenCalledTimes(1)
        expect(
            await f.providers.format.provideDocumentFormattingEdits(m.model, options, {
                ...token,
                isCancellationRequested: true
            })
        ).toEqual([])
        expect(f.api.format.run).toHaveBeenCalledTimes(1)
    })
})
