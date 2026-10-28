import { describe, expect, it } from 'vitest'
import {
    completionName,
    fallbackCandidates,
    indexIdentifiers,
    rankCandidates,
    semanticCandidates,
    supplementalCandidates
} from './ranking'
import { completionContext } from './context'
import { completionOptions, type CompletionOptions } from './options'
import { CompletionUsageStore } from './usage'
import { parentDirectory, sourceUri, type LspCompletionItem } from './protocol'
import { callableParameters } from './callable'

const ctx = (text: string) => completionContext(text, text.length)
const rank = (
    text: string,
    items: LspCompletionItem[],
    options?: Partial<CompletionOptions>,
    usage?: CompletionUsageStore
) => {
    const settings = completionOptions(options),
        context = ctx(text)
    return rankCandidates(
        supplementalCandidates(context, settings),
        semanticCandidates(items, context, settings),
        settings,
        usage
    )
}

describe('general completion ranking', () => {
    it('does not search indefinitely for malformed empty callable names', () => {
        for (const name of ['', '   ']) expect(callableParameters({ label: name, kind: 3 }, name)).toBe('unknown')
        expect(semanticCandidates([{ label: '', kind: 3 }], ctx(''))).toHaveLength(1)
    })
    it('preserves clangd sortText/score order as the base, with no library frequency table', () => {
        expect(
            rank('vec.pu', [
                { label: 'push_front', kind: 2, sortText: '02' },
                { label: 'push_back', kind: 2, sortText: '01' }
            ]).map((item) => item.name)
        ).toEqual(['push_back', 'push_front'])
        expect(
            rank('vec.pu', [
                { label: 'push_front', kind: 2, score: 9 },
                { label: 'push_back', kind: 2, score: 8 }
            ])[0].name
        ).toBe('push_front')
    })
    it('orders scope, usage and prefix quality, retaining arbitrary semantic names at one character', () => {
        const usage = new CompletionUsageStore()
        usage.importUsage({ 'variable:valueExternal': 100, 'variable:valueMember': 20, 'variable:valueLocalB': 3 })
        const items: LspCompletionItem[] = [
            { label: 'valueExternal', context: 'external' },
            { label: 'valueFile', context: 'same-file' },
            { label: 'valueMember', context: 'member' },
            { label: 'valueLocalA', context: 'local' },
            { label: 'valueLocalB', context: 'parameter' }
        ]
        expect(
            rank('v', items, {}, usage)
                .filter((item) => item.semantic)
                .map((item) => item.name)
        ).toEqual(['valueLocalB', 'valueLocalA', 'valueMember', 'valueFile', 'valueExternal'])
        expect(rank('v', items, { sortByScope: false }, usage)[0].name).toBe('valueExternal')
        expect(rank('v', items, { recordUsage: false }, usage)[0].name).toBe('valueLocalA')
        expect(
            rank('v', [{ label: 'solve' }, { label: 'value' }])
                .filter((item) => item.semantic)
                .map((item) => item.name)
        ).toEqual(['value', 'solve'])
    })
    it('uses underscore settings, keeps _lowercase by default and allows an explicit underscore', () => {
        const items = ['_lowercase', '__internal', '_M_impl'].map((label) => ({ label, kind: 5 }))
        expect(rank('v.', items).map((item) => item.name)).toEqual(['_lowercase'])
        expect(rank('v.', items, { hideSymbolsStartsWithUnderLine: true })).toEqual([])
        expect(rank('v.', items, { hideSymbolsStartsWithTwoUnderLine: false }).map((item) => item.name)).toEqual([
            '_lowercase',
            '__internal'
        ])
        expect(rank('v._', items, { hideSymbolsStartsWithUnderLine: true }).map((item) => item.name)).toEqual([
            '_lowercase',
            '__internal',
            '_M_impl'
        ])
        expect(rank('__g', [{ label: '__gcd', kind: 3 }])[0].name).toBe('__gcd')
        // The public symbol is usable even if its implementation lives in a private namespace.
        expect(rank('val', [{ label: 'value', detail: 'std::__detail::value' }])[0].name).toBe('value')
    })
    it('honors ignoreCase and maps filterText to the typed case for Monaco', () => {
        expect(rank('Ve', [{ label: 'vectorValue' }])[0].filterText).toBe('VectorValue')
        expect(rank('Ve', [{ label: 'vector' }], { ignoreCase: false })).toEqual([])
    })
    it('deduplicates overloads and appends a single empty argument stop only when enabled', () => {
        const items = [
            { label: 'push_back', kind: 2 },
            {
                label: 'push_back(const int &value)',
                kind: 2,
                detail: 'void',
                insertText: 'push_back(${1:value})',
                insertTextFormat: 2
            }
        ]
        expect(rank('v.pu', items)).toHaveLength(1)
        expect(rank('v.pu', items)[0].insertText).toBe('push_back($0)')
        expect(rank('v.pu', items)[0].snippet).toBe(true)
        expect(rank('pu', items)[0].insertText).toBe('push_back($0)')
        expect(rank('v.pu', items, { appendFunc: false })[0].insertText).toBe('push_back')
        const context = completionContext('v.pu()', 4)
        expect(semanticCandidates(items, context)[0].insertText).toBe('push_back')
        expect(completionName({ label: 'std::sort(Iterator first, Iterator last)' })).toBe('sort')
    })
    it.each([false, true])(
        'combines overload parameter evidence independently of server order (reverse=%s)',
        (reverse) => {
            const zero = { label: 'query()', kind: 3, sortText: reverse ? '02' : '01' }
            const parameter = { label: 'query(int x = 0)', kind: 3, sortText: reverse ? '01' : '02' }
            const items = reverse ? [parameter, zero] : [zero, parameter]
            expect(rank('qu', items)).toHaveLength(1)
            expect(rank('qu', items)[0].insertText).toBe('query($0)')
            expect(rank('qu', [zero, { label: 'query', kind: 3 }])[0].insertText).toBe('query($0)')
            expect(rank('qu', [zero, { label: 'query(void)', kind: 3 }])[0].insertText).toBe('query()$0')
        }
    )
    it.each(['ready', 'obj.ready', 'obj->ready', 'ns::ready'])(
        'applies zero-parameter behavior consistently to %s',
        (text) => {
            const context = completionContext(text, text.length)
            const items = [{ label: 'ready', kind: 2, labelDetails: { detail: '() const' }, detail: 'bool' }]
            expect(semanticCandidates(items, context)[0]).toMatchObject({ insertText: 'ready()$0', snippet: true })
            expect(semanticCandidates(items, context, completionOptions({ appendFunc: false }))[0]).toMatchObject({
                insertText: 'ready',
                snippet: false
            })
            expect(semanticCandidates(items, completionContext(text + '()', text.length))[0]).toMatchObject({
                insertText: 'ready',
                snippet: false
            })
        }
    )
    it('only adds user snippets after their trigger, and only in plain code', () => {
        const options = { snippets: [{ trigger: 'all', body: '${1:first}.begin(), ${2:last}.end()' }] }
        expect(rank('a', [], options).some((item) => item.category === 'snippet')).toBe(false)
        expect(rank('all', [], options)[0].category).toBe('snippet')
        expect(rank('allx', [], options)[0].category).toBe('snippet')
        for (const text of ['x.all', 'std::all', '#include <all', '// all', '"all'])
            expect(rank(text, [], options)).toEqual([])
        expect(rank('fo', []).some((item) => item.name === 'for')).toBe(true)
        expect(rank('x.fo', [])).toEqual([])
        expect(rank('fo', [{ label: 'for', kind: 14 }], { showKeywords: false })).toEqual([])
        expect(rank('all', [], { snippets: [{ trigger: 'all', body: '${1:v}.begin(), ${1:v}.end()' }] })).toEqual([])
    })
    it('only accepts file/folder items in header completion', () => {
        expect(
            rank('#include <bits/stdc++.', [
                { label: 'stdc++.h', kind: 17 },
                { label: 'all', kind: 15 },
                { label: 'sort', kind: 3 }
            ]).map((item) => item.name)
        ).toEqual(['stdc++.h'])
    })
    it('uses document words only in the offline fallback and excludes comments/strings/current word', () => {
        const text = 'int value; // vanished\nconst char* s = "vampire"; val'
        const words = indexIdentifiers(text)
        expect(words.map((item) => item.name)).not.toContain('vanished')
        expect(words.map((item) => item.name)).not.toContain('vampire')
        expect(fallbackCandidates(ctx(text), words, completionOptions()).map((item) => item.name)).toEqual(['value'])
        expect(fallbackCandidates(ctx('value.'), words, completionOptions())).toEqual([])
    })
})

it('encodes cross-platform source URIs', () => {
    expect(sourceUri('D:\\a b\\x#%.cpp')).toBe('file:///D:/a%20b/x%23%25.cpp')
    expect(sourceUri('/tmp/a b.cpp')).toBe('file:///tmp/a%20b.cpp')
    expect(sourceUri('\\\\server\\share\\a.cpp')).toBe('file://server/share/a.cpp')
    expect(parentDirectory('D:\\a.cpp')).toBe('D:/')
})
