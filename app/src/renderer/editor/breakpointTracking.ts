import type * as Monaco from 'monaco-editor'
import type { Breakpoint } from '../../shared/debug'

/** Map a line's first code character only when formatting preserves every non-whitespace character. */
export function whitespaceLineMap(before: string, after: string, lines: number[]): Map<number, number> | null {
    const wanted = new Set(lines),
        mapped = new Map<number, number>()
    let left = 0,
        right = 0,
        oldLine = 1,
        newLine = 1
    const space = /\s/
    while (left < before.length || right < after.length) {
        while (left < before.length && space.test(before[left])) {
            if (before[left++] === '\n') oldLine++
        }
        while (right < after.length && space.test(after[right])) {
            if (after[right++] === '\n') newLine++
        }
        if (left === before.length || right === after.length)
            return left === before.length && right === after.length ? mapped : null
        if (before[left] !== after[right]) return null
        if (wanted.has(oldLine) && !mapped.has(oldLine)) mapped.set(oldLine, newLine)
        left++
        right++
    }
    return mapped
}

export interface BreakpointFormatSnapshot {
    text: string
    breakpoints: Breakpoint[]
}

/** Model-owned anchors also track edits to background tabs; they are not editor viewport state. */
export class BreakpointTracker {
    private ids: string[] = []
    private values: Breakpoint[] = []
    private updating = false
    private suspended = 0
    private disposed = false
    private text: string
    private readonly changes: Monaco.IDisposable
    private readonly disposal: Monaco.IDisposable
    constructor(
        private readonly model: Monaco.editor.ITextModel,
        private readonly changed: (values: Breakpoint[]) => void,
        private readonly onDispose: () => void
    ) {
        this.text = model.getValue()
        this.changes = model.onDidChangeDecorations(() => this.sync())
        this.disposal = model.onWillDispose(() => {
            this.disposed = true
            this.changes.dispose()
            this.disposal.dispose()
            this.onDispose()
        })
    }

    set(values: Breakpoint[]): void {
        if (this.disposed) return
        this.updating = true
        try {
            this.values = values.map((value) => ({ ...value }))
            this.text = this.model.getValue()
            this.ids = this.model.deltaDecorations(
                this.ids,
                this.values.map((value) => {
                    const column = this.model.getLineFirstNonWhitespaceColumn(value.line) || 1
                    return {
                        range: {
                            startLineNumber: value.line,
                            startColumn: column,
                            endLineNumber: value.line,
                            endColumn: column
                        },
                        options: {
                            glyphMarginClassName: [
                                'nv-bp',
                                value.enabled ? '' : 'nv-bp-off',
                                value.condition || value.hitCondition ? 'nv-bp-cond' : ''
                            ].join(' '),
                            glyphMarginHoverMessage: value.condition
                                ? { value: `条件：\`${value.condition}\`` }
                                : undefined,
                            stickiness: 1
                        }
                    }
                })
            )
        } finally {
            this.updating = false
        }
    }

    sync(): void {
        if (this.disposed || this.updating || this.suspended) return
        const after = this.model.getValue()
        // Native Monaco formatting also applies edits directly, bypassing the save action.
        const mapped =
            after === this.text
                ? null
                : whitespaceLineMap(
                      this.text,
                      after,
                      this.values.map((value) => value.line)
                  )
        const moved = this.values.map((value, index) => ({
            ...value,
            line:
                mapped?.get(value.line) ?? this.model.getDecorationRange(this.ids[index])?.startLineNumber ?? value.line
        }))
        const changed = moved.some((value, index) => value.line !== this.values[index].line)
        this.text = after
        if (mapped) this.set(moved)
        if (!changed) return
        this.values = moved
        this.changed(moved)
    }

    beginFormat(): BreakpointFormatSnapshot {
        this.sync()
        this.suspended++
        return { text: this.model.getValue(), breakpoints: this.values.map((value) => ({ ...value })) }
    }

    finishFormat(snapshot: BreakpointFormatSnapshot): number[] {
        this.suspended = Math.max(0, this.suspended - 1)
        if (this.disposed) return []
        const after = this.model.getValue()
        if (after === snapshot.text) return []
        const mapped = whitespaceLineMap(
            snapshot.text,
            after,
            snapshot.breakpoints.map((value) => value.line)
        )
        const invalid: number[] = []
        const next = snapshot.breakpoints.map((value) => {
            const line = mapped?.get(value.line)
            if (line !== undefined) return { ...value, line }
            if (value.enabled) invalid.push(value.line)
            return { ...value, line: Math.min(value.line, this.model.getLineCount()), enabled: false }
        })
        this.set(next)
        this.changed(next)
        return invalid
    }
}
