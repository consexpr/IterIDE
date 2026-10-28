import type * as Monaco from 'monaco-editor'
import type { IterApi } from '../../shared/api'
import type { FormatRange } from '../../shared/format'

export const formattingToken: Monaco.CancellationToken = {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose() {} })
}

/** A small replacement preserves untouched text, markers and cursor positions. */
export function replacementEdit(model: Monaco.editor.ITextModel, text: string): Monaco.languages.TextEdit[] {
    const before = model.getValue()
    if (before === text) return []
    let start = 0,
        end = before.length,
        nextEnd = text.length
    while (start < end && start < nextEnd && before[start] === text[start]) start++
    while (end > start && nextEnd > start && before[end - 1] === text[nextEnd - 1]) {
        end--
        nextEnd--
    }
    // Do not split UTF-16 surrogate pairs or CRLF sequences at edit boundaries.
    const paired = (value: string, offset: number): boolean =>
        offset > 0 &&
        offset < value.length &&
        ((/[\uD800-\uDBFF]/.test(value[offset - 1]) && /[\uDC00-\uDFFF]/.test(value[offset])) ||
            (value[offset - 1] === '\r' && value[offset] === '\n'))
    if (paired(before, start) || paired(text, start)) start--
    if (paired(before, end) || paired(text, nextEnd)) {
        end++
        nextEnd++
    }
    const from = model.getPositionAt(start),
        to = model.getPositionAt(end)
    return [
        {
            range: {
                startLineNumber: from.lineNumber,
                startColumn: from.column,
                endLineNumber: to.lineNumber,
                endColumn: to.column
            },
            text: text.slice(start, nextEnd)
        }
    ]
}

/** Undefined LSP results mean unavailable/failed; an empty array is successful. */
export async function formattingEdits(
    model: Monaco.editor.ITextModel,
    sourcePath: string,
    api: IterApi,
    clangd: (() => Promise<Monaco.languages.TextEdit[] | undefined>) | undefined,
    token = formattingToken,
    range?: FormatRange,
    current = () => true
): Promise<Monaco.languages.TextEdit[]> {
    const version = model.getVersionId(),
        code = model.getValue(),
        options = model.getOptions()
    const stale = (): boolean =>
        token.isCancellationRequested ||
        model.isDisposed() ||
        model.getVersionId() !== version ||
        !current() ||
        model.getOptions().tabSize !== options.tabSize ||
        model.getOptions().indentSize !== options.indentSize ||
        model.getOptions().insertSpaces !== options.insertSpaces
    if (stale()) return []
    if (clangd) {
        const edits = await clangd()
        if (stale()) return []
        if (edits !== undefined) return edits
    }
    const result = await api.format.run(sourcePath, code, range)
    if (stale()) return []
    if ('error' in result) throw new Error(result.error)
    return replacementEdit(model, result.text)
}
