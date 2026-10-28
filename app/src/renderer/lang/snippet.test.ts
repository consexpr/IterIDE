import { describe, expect, it } from 'vitest'
// Monaco ships this standalone parser as JS, without a public TypeScript declaration.
// @ts-expect-error internal parser is used only to verify Monaco's actual placeholder semantics
import { SnippetParser } from 'monaco-editor/editor/contrib/snippet/browser/snippetParser.js'
import { inspectSnippet, plainCompletionText, validUserSnippet } from './snippet'
import { completionContext } from './context'
import { semanticCandidates, supplementalCandidates } from './ranking'
import { completionOptions } from './options'

describe('single-cursor completion insertion', () => {
    it('places the final cursor after a confirmed zero-parameter call', () => {
        const [item] = semanticCandidates(
            [{ label: 'empty', kind: 2, labelDetails: { detail: '() const' }, detail: 'bool', insertText: 'empty' }],
            completionContext('q.em', 4)
        )
        expect(item.insertText).toBe('empty()$0')
        const parsed = new SnippetParser().parse(item.insertText)
        expect(parsed.toString()).toBe('empty()')
        expect(parsed.placeholders.map((stop: { index: number }) => stop.index)).toEqual([0])
        expect(parsed.offset(parsed.placeholders[0])).toBe('empty()'.length)
    })
    it.each([
        { label: 'ready()', kind: 3 },
        { label: 'ready(void)', kind: 3 },
        { label: 'ready', kind: 3, detail: 'bool () const noexcept' },
        { label: 'ready()', kind: 3, detail: 'int (*)()' },
        { label: 'ready()', kind: 3, detail: 'void (&)()' },
        { label: 'ready()', kind: 3, detail: 'std::function<void()>' },
        { label: 'ready()', kind: 3, detail: 'decltype(factory())' },
        { label: 'ready', kind: 3, insertTextFormat: 2, insertText: 'ready()$0' },
        {
            label: 'ready',
            kind: 3,
            insertTextFormat: 2,
            textEdit: {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } },
                newText: 'ready()$0'
            }
        }
    ])('keeps the single final stop outside calls with explicit empty signatures: %j', (semantic) => {
        const [item] = semanticCandidates([semantic], completionContext('re', 2))
        const parsed = new SnippetParser().parse(item.insertText)
        expect(item.insertText).toBe('ready()$0')
        expect(parsed.placeholders.map((stop: { index: number }) => stop.index)).toEqual([0])
        expect(parsed.offset(parsed.placeholders[0])).toBe('ready()'.length)
    })
    it.each([
        { label: 'query(int x)', kind: 3 },
        { label: 'query(int x = 0)', kind: 3 },
        { label: 'query(...)', kind: 3 },
        { label: 'query(void (*callback)())', kind: 3 },
        { label: 'query', kind: 3, detail: 'void' },
        { label: 'query', kind: 3, detail: 'std::function<void()>' },
        { label: 'query', kind: 3 },
        { label: 'query', kind: 3, insertTextFormat: 2, insertText: 'query($0)' },
        { label: 'query', kind: 3, insertTextFormat: 2, insertText: 'query(${1:})$0' },
        { label: 'query()', kind: 3, insertTextFormat: 2, insertText: 'query(${1:x})$0' },
        { label: 'query()', kind: 3, labelDetails: { detail: '(int x)' } }
    ])('retains an inside cursor for parameter evidence or unknown signatures: %j', (semantic) => {
        const [item] = semanticCandidates([semantic], completionContext('qu', 2))
        const parsed = new SnippetParser().parse(item.insertText)
        expect(item.insertText).toBe('query($0)')
        expect(parsed.placeholders.map((stop: { index: number }) => stop.index)).toEqual([0])
        expect(parsed.offset(parsed.placeholders[0])).toBe('query('.length)
    })
    it('reproduces the mirrored cursor cause with the real Monaco snippet parser and rejects it', () => {
        const mirrored = '${1:v}.begin(), ${1:v}.end()'
        const parsed = new SnippetParser().parse(mirrored)
        expect(parsed.placeholders.filter((stop: { index: number }) => stop.index === 1)).toHaveLength(2)
        expect(validUserSnippet(mirrored)).toBe(false)
        expect(validUserSnippet('${1:v} + $1')).toBe(false)
        expect(validUserSnippet('$0 $0')).toBe(false)
        expect(validUserSnippet('${1:first}.begin(), ${2:last}.end()$0')).toBe(true)
    })
    it('supports unique defaults/choices/nesting/escapes, rejecting malformed stops and transforms', () => {
        for (const body of ['${1:std::vector<${2:int}>} $0', '${1|int,long|} $0', '\\$1 ${1:name}', 'plain text']) {
            expect(validUserSnippet(body), body).toBe(true)
        }
        for (const body of ['${1:broken', '${1|broken}', '${1/(.*)/$1/}', '${NAME}', '$TM_SELECTED_TEXT'])
            expect(validUserSnippet(body), body).toBe(false)
        expect(inspectSnippet('${1|a\\,b,c|} $0').text).toBe('a,b ')
        expect(plainCompletionText('${1:v}.begin(), $1.end()', 2, 'fallback')).toBe('v.begin(), v.end()')
    })
    it('removes all server argument placeholders and creates only one final stop for plain functions', () => {
        const text = 'sor',
            context = completionContext(text, text.length)
        const [item] = semanticCandidates(
            [
                {
                    label: 'sort',
                    kind: 3,
                    insertTextFormat: 2,
                    textEdit: {
                        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
                        newText: 'sort(${1:first}, ${1:first}, ${2:last})$0'
                    }
                }
            ],
            context
        )
        expect(item.insertText).toBe('sort($0)')
        const parsed = new SnippetParser().parse(item.insertText)
        expect(parsed.placeholders.map((stop: { index: number }) => stop.index)).toEqual([0])
        expect(parsed.toString()).toBe('sort()')
    })
    it.each([
        ['qu', 3],
        ['tree.qu', 2],
        ['tree->qu', 2],
        ['std::qu', 3],
        ['Tree::qu', 2],
        ['qu', 4]
    ] as const)('places one cursor inside callable parentheses for %s (kind %s)', (text, kind) => {
        const [item] = semanticCandidates(
            [{ label: 'query', kind, insertTextFormat: 2, insertText: 'query(${1:first}, ${1:first}, ${2:last})$0' }],
            completionContext(text, text.length)
        )
        expect(item.insertText).toBe('query($0)')
        expect(item.snippet).toBe(true)
        const parsed = new SnippetParser().parse(item.insertText)
        expect(parsed.toString()).toBe('query()')
        expect(parsed.placeholders.map((stop: { index: number }) => stop.index)).toEqual([0])
        expect(parsed.offset(parsed.placeholders[0])).toBe('query('.length)
        expect(
            semanticCandidates(
                [{ label: 'query', kind }],
                completionContext(text, text.length),
                completionOptions({ appendFunc: false })
            )[0]
        ).toMatchObject({ insertText: 'query', snippet: false })
        expect(
            semanticCandidates([{ label: 'query', kind }], completionContext(text + '()', text.length))[0]
        ).toMatchObject({ insertText: 'query', snippet: false })
    })
    it('keeps templates and headers plain text even for snippet-style server replies', () => {
        for (const [text, label, kind, raw, expected] of [
            ['Vec', 'Vector', 7, 'Vector<${1:T}>$0', 'Vector<T>'],
            ['#include<vec', 'vector>', 17, 'vector>$0', 'vector>']
        ] as const) {
            const [item] = semanticCandidates(
                [{ label, kind, insertText: raw, insertTextFormat: 2 }],
                completionContext(text, text.length)
            )
            expect(item.insertText).toBe(expected)
            expect(item.snippet).toBe(false)
        }
    })
    it('never passes a repeated placeholder from a user snippet to Monaco', () => {
        const context = completionContext('all', 3)
        const items = supplementalCandidates(
            context,
            completionOptions({
                snippets: [
                    { trigger: 'all', body: '${1:v}.begin(), ${1:v}.end()' },
                    { trigger: 'all', body: '${1:first}.begin(), ${2:last}.end()$0' }
                ]
            })
        )
        expect(items).toHaveLength(1)
        for (const item of items) {
            const parsed = new SnippetParser().parse(item.insertText)
            const indices = parsed.placeholders.map((stop: { index: number }) => stop.index)
            expect(new Set(indices).size).toBe(indices.length)
        }
    })
})
