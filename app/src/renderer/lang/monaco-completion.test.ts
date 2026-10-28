import { afterEach, describe, expect, it, vi } from 'vitest'
// Keep the history widget's DOM/CSS out of this Node test; completion validation and
// fuzzy filtering below are the actual Monaco classes, not copies of their logic.
vi.mock('monaco-editor/platform/history/browser/contextScopedHistoryWidget.js', () => ({
    historyNavigationVisible: {}
}))
vi.mock('monaco-editor/editor/contrib/inlineCompletions/browser/controller/common.js', () => ({
    getInlineCompletionsController: () => undefined
}))
vi.mock('monaco-editor/editor/contrib/snippet/browser/snippetController2.js', () => ({
    SnippetController2: { get: () => undefined }
}))
// @ts-expect-error Monaco exposes these implementation modules as JS without declarations.
import { CompletionItem } from 'monaco-editor/editor/contrib/suggest/browser/suggest.js'
// @ts-expect-error Monaco exposes these implementation modules as JS without declarations.
import { CompletionModel } from 'monaco-editor/editor/contrib/suggest/browser/completionModel.js'
// @ts-expect-error Monaco exposes these implementation modules as JS without declarations.
import { Position } from 'monaco-editor/editor/common/core/position.js'
// @ts-expect-error Monaco exposes these implementation modules as JS without declarations.
import { SuggestModel } from 'monaco-editor/editor/contrib/suggest/browser/suggestModel.js'
// @ts-expect-error Monaco exposes these implementation modules as JS without declarations.
import { BracketSelectionRangeProvider } from 'monaco-editor/editor/contrib/smartSelect/browser/bracketSelections.js'
import { defaultSettings } from '../../shared/settings'
import { fakeModel, fixture, flush, token } from './test-support'
import type { CppLanguageService } from './index'

const services: CppLanguageService[] = []
afterEach(() => {
    for (const service of services.splice(0)) service.dispose()
    vi.restoreAllMocks()
})

describe('Monaco completion validation and visible filtering', () => {
    it.each(['\n', '\r\n'])(
        'keeps an identifier completion inside a closed function (%j line endings)',
        async (eol) => {
            const text = [
                '#include <bits/stdc++.h>',
                'using namespace std;',
                'int main() {',
                '    vector<int> vec;',
                '    long long total = 0;',
                '    ve',
                '}',
                ''
            ].join(eol)
            const f = fixture(),
                m = fakeModel(text)
            services.push(f.service)
            f.settings.completion = defaultSettings().editor.completion
            f.service.attach(m.model, '/tmp/monaco.cpp')
            await flush()
            const position = new Position(6, 7)
            const pending = f.providers.completion.provideCompletionItems(m.model, position, { triggerKind: 0 }, token)
            f.respond(f.requests('textDocument/completion').at(-1).id, {
                items: [
                    {
                        label: ' vec',
                        filterText: 'vec',
                        kind: 6,
                        textEdit: {
                            newText: 'vec',
                            range: { start: { line: 5, character: 4 }, end: { line: 5, character: 6 } }
                        }
                    }
                ]
            })
            const result = await pending
            const items = result.suggestions.map(
                (item: unknown) => new CompletionItem(position, item, result, f.providers.completion)
            )
            const visible = new CompletionModel(
                items,
                position.column,
                { leadingLineContent: '    ve', characterCountDelta: 0 },
                { distance: () => 0 },
                { filterGraceful: true },
                'inline'
            ).items
            expect(visible.map((item: any) => item.completion.label)).toEqual(['vec'])
        }
    )

    it.each([
        { input: 've', name: 'vec', lspKind: 6, kind: 4, insertText: 'vec' },
        { input: 'vec.pu', name: 'push_back', lspKind: 2, kind: 0, insertText: 'push_back($0)' },
        { input: 'q.em', name: 'empty', lspKind: 2, kind: 0, insertText: 'empty()$0', signature: '() const' },
        { input: 'qu', name: 'query', lspKind: 3, kind: 1, insertText: 'query($0)' },
        { input: 'std::qu', name: 'query', lspKind: 3, kind: 1, insertText: 'query($0)' }
    ])(
        'renders $name through SuggestModel once worker word ranges arrive',
        async ({ input, name, lspKind, kind, insertText, signature }) => {
            const text = [
                '#include <bits/stdc++.h>',
                'using namespace std;',
                'int main() {',
                '    vector<int> vec;',
                '    long long total = 0;',
                `    ${input}`,
                '}'
            ].join('\n')
            const f = fixture(),
                m = fakeModel(text),
                position = new Position(6, 5 + input.length)
            services.push(f.service)
            f.settings.completion = defaultSettings().editor.completion
            Object.assign(m.model, { getWordAtPosition: (p: any) => m.model.getWordUntilPosition(p) })
            f.service.attach(m.model, '/tmp/suggest.cpp')
            await flush()
            const scope = { startLineNumber: 3, startColumn: 13, endLineNumber: 7, endColumn: 1 }
            vi.spyOn(BracketSelectionRangeProvider.prototype, 'provideSelectionRanges').mockResolvedValue([
                [{ range: scope }]
            ])
            let finishRanges!: (words: Record<string, unknown[]>) => void
            const worker = {
                canComputeWordRanges: () => true,
                computeWordRanges: vi.fn(
                    () =>
                        new Promise((resolve) => {
                            finishRanges = resolve
                        })
                )
            }
            const event = () => ({ dispose() {} })
            const suggestOptions = new Proxy(
                { localityBonus: true, filterGraceful: true, matchOnWordStartOnly: true },
                {
                    get: (target, key) => (key in target ? target[key as keyof typeof target] : true)
                }
            )
            const editor = {
                hasModel: () => true,
                getModel: () => m.model,
                getPosition: () => position,
                getSelection: () => position,
                getOption: (option: number) =>
                    option === 128 ? 'inline' : option === 134 ? suggestOptions : option === 137,
                onDidChangeModel: event,
                onDidChangeModelLanguage: event,
                onDidChangeConfiguration: event,
                onDidCompositionStart: event,
                onDidCompositionEnd: event,
                onDidChangeCursorSelection: event,
                onDidChangeModelContent: event,
                onDidType: event
            }
            const provider = f.providers.completion
            const supplied = vi.spyOn(provider, 'provideCompletionItems')
            const registry = { onDidChange: event, all: () => [provider], orderedGroups: () => [[provider]] }
            const suggest = new SuggestModel(
                editor,
                worker,
                {},
                {},
                { warn: vi.fn() },
                {},
                {},
                { completionProvider: registry },
                { isBuilt: true }
            )
            const shown = vi.fn()
            suggest.onDidSuggest((event: any) =>
                shown(event.completionModel.items.map((item: any) => item.completion.label))
            )
            try {
                suggest.trigger({ auto: false })
                f.respond(f.requests('textDocument/completion').at(-1).id, {
                    items: [
                        {
                            label: ` ${name}`,
                            filterText: name,
                            kind: lspKind,
                            detail: 'clangd type',
                            labelDetails: { detail: signature },
                            textEdit: {
                                newText: name,
                                range: {
                                    start: { line: 5, character: position.column - 3 },
                                    end: { line: 5, character: position.column - 1 }
                                }
                            }
                        }
                    ]
                })
                expect((await supplied.mock.results[0].value).suggestions[0]).toMatchObject({
                    label: name,
                    kind,
                    insertText,
                    insertTextRules: lspKind === 6 ? undefined : 4,
                    command: { title: 'Accept completion' }
                })
                await flush()
                expect(worker.computeWordRanges).toHaveBeenCalledOnce()
                expect(shown).not.toHaveBeenCalled() // Reproduces the empty widget with an uninitialized worker.
                finishRanges({ vec: [{ startLineNumber: 4, startColumn: 17, endLineNumber: 4, endColumn: 20 }] })
                await flush()
                expect(shown).toHaveBeenCalledWith([name])
            } finally {
                suggest.dispose()
            }
        }
    )
})
