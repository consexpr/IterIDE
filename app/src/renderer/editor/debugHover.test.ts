import type * as Monaco from 'monaco-editor'
import { describe, expect, it, vi } from 'vitest'
import { createDebugHoverProvider, debugExpressionAt } from './debugHover'

const range = (
    startColumn: number,
    endColumn: number,
    startLineNumber = 1,
    endLineNumber = startLineNumber
): Monaco.IRange => ({ startLineNumber, startColumn, endLineNumber, endColumn })
const position = (column: number, lineNumber = 1): Monaco.Position => ({ lineNumber, column }) as Monaco.Position
const token = (): Monaco.CancellationToken => ({
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose() {} })
})

function modelFixture(initial: string) {
    let text = initial,
        version = 1,
        disposed = false
    const lines = (): string[] => text.split('\n').map((line) => line.replace(/\r$/, ''))
    const offset = (p: Monaco.IPosition): number =>
        text
            .split('\n')
            .slice(0, p.lineNumber - 1)
            .reduce((sum, line) => sum + line.length + 1, 0) +
        p.column -
        1
    const slice = (r: Monaco.IRange): string =>
        text.slice(
            offset({ lineNumber: r.startLineNumber, column: r.startColumn }),
            offset({ lineNumber: r.endLineNumber, column: r.endColumn })
        )
    const model = {
        isDisposed: () => disposed,
        getVersionId: () => version,
        getLineCount: () => lines().length,
        getLineMaxColumn: (line: number) => lines()[line - 1].length + 1,
        getLineContent: (line: number) => lines()[line - 1],
        getValueInRange: slice,
        getValueLengthInRange: (r: Monaco.IRange) => slice(r).length,
        getWordAtPosition: (p: Monaco.IPosition) => {
            const match = [...lines()[p.lineNumber - 1].matchAll(/\w+/g)].find(
                (word) => word.index! < p.column && word.index! + word[0].length >= p.column - 1
            )
            return match
                ? { word: match[0], startColumn: match.index! + 1, endColumn: match.index! + match[0].length + 1 }
                : null
        }
    } as unknown as Monaco.editor.ITextModel
    return {
        model,
        edit(next: string) {
            text = next
            version++
        },
        dispose() {
            disposed = true
        }
    }
}

function fixture(text = 'a + b; A[i]; other', selected: Monaco.IRange | null = range(1, 6)) {
    const source = modelFixture(text)
    let selection = selected,
        activeModel: Monaco.editor.ITextModel | null = source.model,
        pause: string | null = 'session:1;step:0;frame:0'
    const originalEditor = { getModel: () => activeModel, getSelection: () => selection }
    let editor: typeof originalEditor | null = originalEditor
    const inspect = vi.fn(
        async (_text: string): Promise<{ value: string; type?: string } | null> => ({ value: '16', type: 'int' })
    )
    const provider = createDebugHoverProvider({ editor: () => editor, pause: () => pause, inspect })
    return {
        ...source,
        inspect,
        hover: (p = position(3), cancellation = token()) =>
            Promise.resolve(provider.provideHover(source.model, p, cancellation)),
        select: (next: Monaco.IRange | null) => {
            selection = next
        },
        pause: (next: string | null) => {
            pause = next
        },
        changeModel: () => {
            activeModel = modelFixture('a + b').model
        },
        replaceEditor: () => {
            editor = { ...originalEditor }
        },
        closeEditor: () => {
            editor = null
        }
    }
}

describe('debug hover expression targeting', () => {
    it.each([position(1), position(2), position(3), position(5)])(
        'inspects the full selected a + b at %j, including whitespace and operators',
        (p) => {
            const { model } = modelFixture('a + b')
            expect(debugExpressionAt(model, p, range(1, 6))).toEqual({ text: 'a + b', range: range(1, 6) })
        }
    )

    it.each([position(1), position(2), position(3), position(4)])(
        'inspects the selected A[i] over each selected character (%j)',
        (p) => {
            const { model } = modelFixture('A[i]')
            expect(debugExpressionAt(model, p, range(1, 5))?.text).toBe('A[i]')
        }
    )

    it('uses ordinary identifiers outside a selection, including its exclusive end', () => {
        const { model } = modelFixture('a + b; i')
        expect(debugExpressionAt(model, position(6), range(1, 6))?.text).toBe('b')
        expect(debugExpressionAt(model, position(8), range(1, 6))?.text).toBe('i')
        expect(debugExpressionAt(model, position(1), range(8, 9))?.text).toBe('a')
        expect(debugExpressionAt(model, position(5), range(3, 3))?.text).toBe('b')
    })

    it('preserves existing member/array chains and plain array index word hovers', () => {
        const { model } = modelFixture('obj.a[i].value + ptr->field + A[i]')
        expect(debugExpressionAt(model, position(12), null)?.text).toBe('obj.a[i].value')
        expect(debugExpressionAt(model, position(23), null)?.text).toBe('ptr->field')
        expect(debugExpressionAt(model, position(31), null)?.text).toBe('A')
        expect(debugExpressionAt(model, position(33), null)?.text).toBe('i')
    })

    it.each(['\n', '\r\n'])('preserves multiline expression text and the complete selected range (%j)', (eol) => {
        const { model } = modelFixture(`  a +${eol} b  `),
            selected = range(1, 5, 1, 2)
        expect(debugExpressionAt(model, position(2, 2), selected)).toEqual({ text: `a +${eol} b`, range: selected })
        expect(debugExpressionAt(model, position(5, 2), selected)).toBeNull()
    })

    it.each(['a = b', 'i++', '++i', 'f()', '(f)(i)', 'obj.f()', 'A[i++]', 'delete p', 'a; b', ' '])(
        'never falls back to a word within rejected selection %j',
        (text) => {
            const { model } = modelFixture(text)
            expect(debugExpressionAt(model, position(1), range(1, text.length + 1))).toBeNull()
        }
    )

    it('bounds selected input and rejects malformed positions/ranges or disposed models', () => {
        const source = modelFixture('a'.repeat(4097))
        expect(debugExpressionAt(source.model, position(1), range(1, 4098))).toBeNull()
        expect(debugExpressionAt(source.model, position(0), null)).toBeNull()
        expect(debugExpressionAt(source.model, position(1, 2), null)).toBeNull()
        expect(debugExpressionAt(source.model, position(1), range(3, 2))).toBeNull()
        expect(debugExpressionAt(source.model, position(1), range(1, Infinity))).toBeNull()
        source.dispose()
        expect(debugExpressionAt(source.model, position(1), null)).toBeNull()
    })
})

describe('paused asynchronous debug inspection', () => {
    it('evaluates selected expressions and returns the full Monaco hover range/value', async () => {
        const f = fixture()
        const result = await f.hover()
        expect(f.inspect).toHaveBeenCalledExactlyOnceWith('a + b')
        expect(result).toMatchObject({
            range: range(1, 6),
            contents: [{ value: '**a \\+ b**  `int`' }, { value: '```cpp\n16\n```' }]
        })
        f.select(range(8, 12))
        await f.hover(position(10))
        expect(f.inspect).toHaveBeenLastCalledWith('A[i]')
    })

    it.each(['running', 'idle', 'cancelled', 'inactive model', 'closed editor', 'unsafe expression'])(
        'does not inspect while %s',
        async (reason) => {
            const f = fixture(),
                cancellation = token()
            if (reason === 'running' || reason === 'idle') f.pause(null)
            if (reason === 'cancelled') Object.assign(cancellation, { isCancellationRequested: true })
            if (reason === 'inactive model') f.changeModel()
            if (reason === 'closed editor') f.closeEditor()
            if (reason === 'unsafe expression') f.edit('a = b')
            expect(await f.hover(position(3), cancellation)).toBeNull()
            expect(f.inspect).not.toHaveBeenCalled()
        }
    )

    it.each(['cancel', 'step', 'frame', 'session', 'running', 'selection', 'model', 'edit', 'dispose', 'editor'])(
        'discards a late response after %s changes',
        async (change) => {
            const f = fixture(),
                cancellation = token()
            let finish!: (value: { value: string }) => void
            f.inspect.mockImplementation(
                () =>
                    new Promise((resolve) => {
                        finish = resolve
                    })
            )
            const pending = f.hover(position(3), cancellation)
            if (change === 'cancel') Object.assign(cancellation, { isCancellationRequested: true })
            if (change === 'step') f.pause('session:1;step:1;frame:0')
            if (change === 'frame') f.pause('session:1;step:0;frame:1')
            if (change === 'session') f.pause('session:2;step:0;frame:0')
            if (change === 'running') f.pause(null)
            if (change === 'selection') f.select(range(8, 12))
            if (change === 'model') f.changeModel()
            if (change === 'edit') f.edit('x + y; A[i]; other')
            if (change === 'dispose') f.dispose()
            if (change === 'editor') f.replaceEditor()
            finish({ value: 'old value' })
            expect(await pending).toBeNull()
        }
    )

    it('keeps the new selected expression when older inspection finishes last', async () => {
        const f = fixture()
        let first!: (value: { value: string }) => void
        f.inspect.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    first = resolve
                })
        )
        const old = f.hover()
        f.select(range(8, 12))
        f.inspect.mockResolvedValueOnce({ value: '22' })
        expect(await f.hover(position(10))).toMatchObject({
            contents: [{ value: '**A\\[i\\]**' }, { value: '```cpp\n22\n```' }]
        })
        first({ value: '16' })
        expect(await old).toBeNull()
    })

    it('swallows rejected/null/malformed responses and bounds rendered output', async () => {
        const f = fixture()
        f.inspect.mockRejectedValueOnce(new Error('stopped'))
        expect(await f.hover()).toBeNull()
        f.inspect.mockResolvedValueOnce(null)
        expect(await f.hover()).toBeNull()
        f.inspect.mockResolvedValueOnce({ value: 7 } as unknown as { value: string })
        expect(await f.hover()).toBeNull()
        f.inspect.mockResolvedValueOnce({ value: '{1, 2}', type: 'std::vector<int>' })
        expect((await f.hover())?.contents[0].value).toBe('**a \\+ b**  `std::vector<int>`')
        f.inspect.mockResolvedValueOnce({ value: '```\n' + 'x'.repeat(5000) })
        const result = await f.hover()
        expect(result?.contents[1].value).toBe('````cpp\n' + ('```\n' + 'x'.repeat(5000)).slice(0, 4000) + '\n````')
    })
})
