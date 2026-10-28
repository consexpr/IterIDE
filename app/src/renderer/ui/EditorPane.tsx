import { useEffect, useRef, useState } from 'react'
import { renderBreakpoints, toggleBreakpoint } from '../actions/debug'
import { registerEditorMenu } from '../editor/contextMenu'
import { activate } from '../actions/files'
import { editorRef } from '../editor/instance'
import { editorOptions, monaco } from '../editor/monaco'
import { applyModelIndentation } from '../editor/indentation'
import { activeFile, store, useApp } from '../state/app'
import { setCursor } from '../state/cursor'
import { GutterMenu, type GutterMenuAt } from './GutterMenu'
import { Welcome } from './Welcome'
import { FindPanel } from './FindPanel'
import { installSearch } from '../editor/search'

export function EditorPane() {
    const host = useRef<HTMLDivElement>(null)
    const editorSettings = useApp((s) => s.settings.editor)
    const hasFile = useApp((s) => s.activePath !== null)
    const [gutterMenu, setGutterMenu] = useState<GutterMenuAt | null>(null)

    useEffect(() => {
        const ed = monaco.editor.create(host.current!, { ...editorOptions(store.get().settings.editor), model: null })
        editorRef.editor = ed
        const disposeSearch = installSearch(ed)
        const T = monaco.editor.MouseTargetType
        const inGutter = (t: monaco.editor.MouseTargetType): boolean =>
            t === T.GUTTER_GLYPH_MARGIN || t === T.GUTTER_LINE_NUMBERS
        ed.onMouseDown((e) => {
            // a click anywhere in the gutter toggles a breakpoint (Red Panda); keep the caret where it was
            if (!inGutter(e.target.type) || !e.target.position || !e.event.leftButton) return
            const keep = ed.getSelections()
            toggleBreakpoint(e.target.position.lineNumber)
            if (keep) setTimeout(() => ed.setSelections(keep))
        })
        ed.onContextMenu((e) => {
            if (!inGutter(e.target.type) || !e.target.position) return
            e.event.preventDefault()
            setGutterMenu({ x: e.event.posx, y: e.event.posy, line: e.target.position.lineNumber })
        })
        ed.onDidChangeModel(() => renderBreakpoints())
        registerEditorMenu(ed)
        ed.onDidChangeCursorPosition((e) => setCursor(e.position.lineNumber, e.position.column))
        // re-attach the active model if files were opened before the editor mounted
        const f = activeFile()
        if (f) activate(f.path)
        return () => {
            disposeSearch()
            ed.dispose()
            editorRef.editor = null
        }
    }, [])

    useEffect(() => {
        for (const file of store.get().files) applyModelIndentation(file.model, editorSettings, true, editorRef.editor)
        editorRef.editor?.updateOptions(editorOptions(editorSettings))
        // fonts may load late; re-measure so the cursor isn't misplaced
        void document.fonts.ready.then(() => monaco.editor.remeasureFonts())
    }, [editorSettings])

    return (
        <div className="nv-editor-wrap">
            <div ref={host} className="nv-editor" style={{ visibility: hasFile ? 'visible' : 'hidden' }} />
            {!hasFile && <Welcome />}
            <FindPanel />
            {gutterMenu && <GutterMenu at={gutterMenu} onClose={() => setGutterMenu(null)} />}
        </div>
    )
}
