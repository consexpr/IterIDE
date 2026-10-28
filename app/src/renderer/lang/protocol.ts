export interface LspPosition {
    line: number
    character: number
}
export interface LspRange {
    start: LspPosition
    end: LspPosition
}
export interface LspTextEdit {
    range: LspRange
    newText: string
}
export interface LspCompletionItem {
    label: string
    labelDetails?: { detail?: string; description?: string }
    kind?: number
    detail?: string
    documentation?: string | { kind?: string; value: string }
    filterText?: string
    sortText?: string
    /** Optional clangd/extensions hints; sortText remains the authoritative base order. */
    score?: number
    context?: string | { kind?: string; scope?: string }
    insertText?: string
    insertTextFormat?: number
    textEdit?: LspTextEdit | { insert: LspRange; replace: LspRange; newText: string }
    additionalTextEdits?: LspTextEdit[]
}
export interface LspCompletionList {
    items: LspCompletionItem[]
    isIncomplete?: boolean
    itemDefaults?: { editRange?: LspRange | { insert: LspRange; replace: LspRange }; insertTextFormat?: number }
}
export interface LspDiagnostic {
    range: LspRange
    severity?: number
    message: string
    source?: string
    code?: number | string
}

export const lspPosition = (position: { lineNumber: number; column: number }): LspPosition => ({
    line: position.lineNumber - 1,
    character: position.column - 1
})
export const monacoRange = (
    range: LspRange
): { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number } => ({
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1
})

/** No node:path in the sandboxed renderer. Handles drive letters, UNC and POSIX. */
export function sourceUri(sourcePath: string): string {
    const normalized = sourcePath.replace(/\\/g, '/')
    if (normalized.startsWith('//')) {
        const [host, ...parts] = normalized.slice(2).split('/')
        return `file://${host}/${parts.map(encodeURIComponent).join('/')}`
    }
    return `file://${normalized.startsWith('/') ? '' : '/'}${normalized
        .split('/')
        .map((part, index) => (index === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)))
        .join('/')}`
}
export function parentDirectory(sourcePath: string): string {
    const normalized = sourcePath.replace(/\\/g, '/')
    const index = normalized.lastIndexOf('/')
    return index < 0 ? '.' : normalized.slice(0, index + 1)
}

/** Windows file URIs are case insensitive, and servers can normalize percent escapes. */
export function uriKey(uri: string): string {
    try {
        const url = new URL(uri)
        const decoded = decodeURIComponent(url.pathname)
        const key = `${url.protocol}//${url.host}${decoded}`
        return url.host || /^\/[A-Za-z]:\//.test(decoded) ? key.toLowerCase() : key
    } catch {
        return uri
    }
}

export function markdown(value: unknown): string {
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value.map(markdown).filter(Boolean).join('\n\n')
    if (value && typeof value === 'object' && 'value' in value && typeof value.value === 'string') {
        return 'language' in value ? `\`\`\`${String(value.language)}\n${value.value}\n\`\`\`` : value.value
    }
    return ''
}
