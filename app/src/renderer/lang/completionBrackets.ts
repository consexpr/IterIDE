import type * as Monaco from 'monaco-editor'

/** Monaco's suggest edits no longer register snippet parentheses as auto-closed.
 * Reapply only our freshly appended empty pairs through its native snippet path,
 * preserving its overtype/delete tracking and the completion's single undo step.
 */
export function trackCompletionParentheses(editor: Monaco.editor.ICodeEditor): void {
    const model = editor.getModel(),
        selections = editor.getSelections()
    if (!model || !selections?.length) return
    const edits: Monaco.editor.IIdentifiedSingleEditOperation[] = []
    for (const selection of selections) {
        if (!selection.isEmpty() || selection.positionColumn < 2) return
        const range = {
            startLineNumber: selection.positionLineNumber,
            endLineNumber: selection.positionLineNumber,
            startColumn: selection.positionColumn - 1,
            endColumn: selection.positionColumn + 1
        }
        if (model.getValueInRange(range) !== '()') return
        edits.push({ range, text: '()' })
    }
    editor.popUndoStop()
    editor.executeEdits('snippet', edits, selections)
    editor.pushUndoStop()
}
