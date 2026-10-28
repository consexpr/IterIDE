import type * as Monaco from 'monaco-editor'
import { isReadOnlyDebugExpression } from '../../shared/debugExpression'

type HoverModel = Pick<
    Monaco.editor.ITextModel,
    | 'isDisposed'
    | 'getVersionId'
    | 'getLineCount'
    | 'getLineMaxColumn'
    | 'getLineContent'
    | 'getWordAtPosition'
    | 'getValueLengthInRange'
    | 'getValueInRange'
>
type HoverEditor = { getModel(): HoverModel | null; getSelection(): Monaco.IRange | null }
type HoverExpression = { text: string; range: Monaco.IRange }
interface DebugHoverContext {
    editor(): HoverEditor | null
    /** Stable for one paused navigation/frame/session; null when inspection is unavailable. */
    pause(): string | null
    inspect(expression: string): Promise<{ value: string; type?: string } | null>
}

const MAX_EXPRESSION = 4096
const rangeKey = (r: Monaco.IRange | null): string =>
    r ? `${r.startLineNumber}:${r.startColumn}:${r.endLineNumber}:${r.endColumn}` : ''
const before = (a: Monaco.IPosition, b: Monaco.IPosition): boolean =>
    a.lineNumber < b.lineNumber || (a.lineNumber === b.lineNumber && a.column < b.column)
const startOf = (r: Monaco.IRange): Monaco.IPosition => ({ lineNumber: r.startLineNumber, column: r.startColumn })
const endOf = (r: Monaco.IRange): Monaco.IPosition => ({ lineNumber: r.endLineNumber, column: r.endColumn })

function validPosition(model: HoverModel, p: Monaco.IPosition): boolean {
    return (
        Number.isSafeInteger(p.lineNumber) &&
        p.lineNumber >= 1 &&
        p.lineNumber <= model.getLineCount() &&
        Number.isSafeInteger(p.column) &&
        p.column >= 1 &&
        p.column <= model.getLineMaxColumn(p.lineNumber)
    )
}

/** Use the selection only over its selected characters, with an exclusive end. */
export function debugExpressionAt(
    model: HoverModel,
    pos: Monaco.IPosition,
    selection: Monaco.IRange | null
): HoverExpression | null {
    if (model.isDisposed() || !validPosition(model, pos)) return null
    if (selection) {
        const start = startOf(selection),
            end = endOf(selection)
        if (!validPosition(model, start) || !validPosition(model, end) || before(end, start)) return null
        if (before(start, end) && !before(pos, start) && before(pos, end)) {
            if (model.getValueLengthInRange(selection) > MAX_EXPRESSION) return null
            // Preserve internal spaces/newlines: GDB reads the same expression the user selected.
            const text = model.getValueInRange(selection).trim()
            return text && isReadOnlyDebugExpression(text) ? { text, range: { ...selection } } : null
        }
    }
    const word = model.getWordAtPosition(pos)
    if (!word || !/^[A-Za-z_]\w*$/.test(word.word)) return null
    const line = model.getLineContent(pos.lineNumber)
    let start = word.startColumn - 1
    const end = word.endColumn - 1
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end) || end <= start || end > line.length)
        return null
    // Preserve ordinary identifier/member hovers when the pointer is outside the selection.
    for (;;) {
        const match = /(?:[A-Za-z_]\w*(?:\[[^\]]*\])*)(?:\.|->)$/.exec(line.slice(0, start))
        if (!match) break
        start -= match[0].length
    }
    const text = line.slice(start, end)
    if (
        text.length > MAX_EXPRESSION ||
        /^(int|long|return|for|while|if|else|auto|const|using|namespace|include)$/.test(text) ||
        !isReadOnlyDebugExpression(text)
    )
        return null
    return {
        text,
        range: {
            startLineNumber: pos.lineNumber,
            startColumn: start + 1,
            endLineNumber: pos.lineNumber,
            endColumn: end + 1
        }
    }
}

const markdownText = (text: string): string => text.replace(/[\\`*_{}\[\]()<>#+.!|~-]/g, '\\$&')
const backtickFence = (text: string, minimum: number): string =>
    '`'.repeat(Math.max(minimum, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length + 1)))
function codeBlock(text: string): string {
    const fence = backtickFence(text, 3)
    return `${fence}cpp\n${text}\n${fence}`
}

/** One asynchronous inspection belongs to the editor selection and exact paused context that requested it. */
export function createDebugHoverProvider(context: DebugHoverContext): Monaco.languages.HoverProvider {
    return {
        async provideHover(model, pos, token) {
            const editor = context.editor(),
                pause = context.pause()
            if (
                !editor ||
                editor.getModel() !== model ||
                pause === null ||
                token.isCancellationRequested ||
                model.isDisposed()
            )
                return null
            const selection = editor.getSelection(),
                selectionKey = rangeKey(selection),
                version = model.getVersionId()
            const expression = debugExpressionAt(model, pos, selection)
            if (!expression) return null
            let result: { value: string; type?: string } | null
            try {
                result = await context.inspect(expression.text)
            } catch {
                return null
            }
            if (
                !result ||
                typeof result.value !== 'string' ||
                (result.type !== undefined && typeof result.type !== 'string') ||
                token.isCancellationRequested ||
                model.isDisposed() ||
                model.getVersionId() !== version ||
                context.editor() !== editor ||
                editor.getModel() !== model ||
                context.pause() !== pause ||
                rangeKey(editor.getSelection()) !== selectionKey
            )
                return null
            const typeText = result.type?.slice(0, 512),
                typeFence = typeText ? backtickFence(typeText, 1) : ''
            const type = typeText ? `  ${typeFence}${typeText}${typeFence}` : ''
            return {
                range: expression.range,
                contents: [
                    { value: `**${markdownText(expression.text)}**${type}` },
                    { value: codeBlock(result.value.slice(0, 4000)) }
                ]
            }
        }
    }
}
