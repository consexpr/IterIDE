/** One-based line/column positions; columns count UTF-16 code units, like Monaco. */
export interface FormatRange {
    startLineNumber: number
    startColumn: number
    endLineNumber: number
    endColumn: number
}
export type FormatResult = { text: string } | { error: string }

export const DEFAULT_CLANG_FORMAT_STYLE =
    '{BasedOnStyle: LLVM, IndentWidth: 4, ColumnLimit: 120, AllowShortIfStatementsOnASingleLine: WithoutElse, AllowShortLoopsOnASingleLine: true, AllowShortBlocksOnASingleLine: Empty}'
