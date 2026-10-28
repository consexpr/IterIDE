import type { editor } from 'monaco-editor'

// Hot-exit session: every open tab with its live buffer and editor position.

export interface SessionTab {
    path: string
    /** Number N of an `Untitled-N` tab; its file is app-managed (see main/untitled.ts). */
    untitled?: number
    /** A recovered buffer still awaits an explicit save or external-file adoption. */
    missing?: boolean
    /** The buffer as it was. */
    text: string
    /** The last saved text; a tab is unsaved while `text` differs. */
    saved: string
    viewState?: editor.ICodeEditorViewState
}

/** Keep opaque folding state, but reject invalid positions or oversized contribution payloads. */
export function sanitizeViewState(value: unknown): editor.ICodeEditorViewState | undefined {
    if (!value || typeof value !== 'object') return undefined
    const state = value as editor.ICodeEditorViewState
    const position = (p: unknown): boolean => {
        const v = p as { lineNumber?: number; column?: number } | null
        return (
            !!v &&
            Number.isSafeInteger(v.lineNumber) &&
            v.lineNumber! > 0 &&
            Number.isSafeInteger(v.column) &&
            v.column! > 0
        )
    }
    if (
        !Array.isArray(state.cursorState) ||
        state.cursorState.length > 1000 ||
        !state.cursorState.every(
            (cursor) =>
                cursor &&
                typeof cursor.inSelectionMode === 'boolean' &&
                position(cursor.selectionStart) &&
                position(cursor.position)
        ) ||
        !state.viewState ||
        !position(state.viewState.firstPosition) ||
        !Number.isFinite(state.viewState.scrollLeft) ||
        state.viewState.scrollLeft < 0 ||
        !Number.isFinite(state.viewState.firstPositionDeltaTop) ||
        !state.contributionsState ||
        typeof state.contributionsState !== 'object' ||
        Array.isArray(state.contributionsState)
    )
        return undefined
    try {
        const json = JSON.stringify(state)
        return json.length <= 65_536 ? JSON.parse(json) : undefined
    } catch {
        return undefined
    }
}

export interface SessionData {
    version: 1
    active: string | null
    tabs: SessionTab[]
}
