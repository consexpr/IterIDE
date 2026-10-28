import { Store, useStore } from './store'

export interface CursorPosition {
    line: number
    col: number
}

/** Cursor movement must not notify every test card and application-state subscriber. */
export const cursorStore = new Store<CursorPosition>({ line: 1, col: 1 })
const select = (position: CursorPosition): CursorPosition => position
export const useCursor = (): CursorPosition => useStore(cursorStore, select)
export function setCursor(line: number, col: number): void {
    const current = cursorStore.get()
    if (current.line !== line || current.col !== col) cursorStore.set({ line, col })
}
