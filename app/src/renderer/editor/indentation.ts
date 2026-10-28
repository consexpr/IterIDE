import type * as Monaco from 'monaco-editor'
import { indentationSettings, type IndentationSettings } from '../../shared/indentation'
import { monaco } from './monaco'

/** Change leading whitespace only. Strings spanning lines contain data, not indentation. */
export function applyModelIndentation(
    model: Monaco.editor.ITextModel,
    setting: IndentationSettings,
    reindent = false,
    editor?: Monaco.editor.IStandaloneCodeEditor | null
): void {
    if (model.isDisposed()) return
    const next = indentationSettings(setting),
        previous = model.getOptions()
    const changed =
        previous.tabSize !== next.tabSize ||
        previous.indentSize !== next.tabSize ||
        previous.insertSpaces !== next.insertSpaces
    const edits: Monaco.editor.IIdentifiedSingleEditOperation[] = []
    if (reindent && changed) {
        const tokens = monaco.editor.tokenize(model.getValue(), model.getLanguageId())
        for (let line = 1; line <= model.getLineCount(); line++) {
            // A backslash splice can continue a character literal or a macro across physical lines.
            if (line > 1 && /\\[\t ]*$/.test(model.getLineContent(line - 1))) continue
            if (tokens[line - 1]?.[0]?.type.startsWith('string')) continue
            const prefix = /^[\t ]*/.exec(model.getLineContent(line))![0]
            if (!prefix) continue
            let width = 0
            for (const char of prefix) width += char === '\t' ? previous.tabSize - (width % previous.tabSize) : 1
            const levels = Math.floor(width / previous.indentSize),
                remainder = width % previous.indentSize
            const text =
                (next.insertSpaces ? ' '.repeat(levels * next.tabSize) : '\t'.repeat(levels)) + ' '.repeat(remainder)
            if (text !== prefix) edits.push({ range: new monaco.Range(line, 1, line, prefix.length + 1), text })
        }
    }
    model.updateOptions({ ...next, indentSize: next.tabSize, trimAutoWhitespace: false })
    if (!edits.length) return
    model.pushStackElement()
    if (editor?.getModel() !== model || editor.executeEdits('iter.indentation', edits) === false)
        model.pushEditOperations([], edits, () => null)
    model.pushStackElement()
}
