// Debug entries in the editor's right-click menu (Red Panda puts these on the editor menu too).
import { addWatchFromEditor, editBreakpointAtCursor, runToCursor, toggleBreakpoint } from '../actions/debug'
import type { monaco } from './monaco'

export function registerEditorMenu(ed: monaco.editor.IStandaloneCodeEditor): void {
    // shortcuts stay off these labels: they are rebound outside Monaco, so Monaco can't right-align them
    const item = (id: string, label: string, order: number, run: () => unknown): void => {
        ed.addAction({
            id: `iter.${id}`,
            label,
            contextMenuGroupId: '0_iter_debug',
            contextMenuOrder: order,
            run: () => void run()
        })
    }
    item('runToCursor', '执行到光标处', 1, () => runToCursor())
    item('toggleBreakpoint', '切换断点', 2, () => {
        const line = ed.getPosition()?.lineNumber
        if (line) toggleBreakpoint(line)
    })
    item('breakpointProps', '断点属性…', 3, editBreakpointAtCursor)
    item('addWatch', '添加监视', 4, addWatchFromEditor)
}
