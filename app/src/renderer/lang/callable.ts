import type { LspCompletionItem } from './protocol'

export type CallableParameters = 'empty' | 'present' | 'unknown'

/** Read only the outer argument list; a callback's own () is not the call's arity. */
function parameterList(signature: string): string | undefined {
    let at = 0
    while (/\s/.test(signature[at] ?? '') && at < signature.length) at++
    if (signature[at] === '<') {
        let depth = 0
        for (; at < signature.length; at++) {
            if (signature[at] === '<') depth++
            else if (signature[at] === '>' && --depth === 0) {
                at++
                break
            }
        }
        while (/\s/.test(signature[at] ?? '') && at < signature.length) at++
    }
    if (signature[at] !== '(') return undefined
    const start = ++at
    let depth = 1,
        quote = ''
    for (; at < signature.length; at++) {
        const char = signature[at]
        if (quote) {
            if (char === '\\') at++
            else if (char === quote) quote = ''
        } else if (char === '"' || char === "'") quote = char
        else if (char === '(') depth++
        else if (char === ')' && --depth === 0) return signature.slice(start, at)
    }
    return undefined
}

function namedParameters(text: string | undefined, name: string): string | undefined {
    if (!text || !name) return undefined
    for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + name.length)) {
        if (/[\w$]/.test(text[at - 1] ?? '') || /[\w$]/.test(text[at + name.length] ?? '')) continue
        const parameters = parameterList(text.slice(at + name.length))
        if (parameters !== undefined) return parameters
    }
    return undefined
}

/** clangd usually sends only the return type in detail, but other LSP servers
 * can send a function type. Ignore parentheses nested in a return type template.
 */
function typeParameters(detail: string | undefined): string | undefined {
    if (!detail) return undefined
    let angle = 0
    for (let at = 0; at < detail.length; at++) {
        if (detail[at] === '<') angle++
        else if (detail[at] === '>') angle = Math.max(0, angle - 1)
        else if (detail[at] === '(' && angle === 0) {
            // These are return-type expressions/declarators, not a callable signature.
            if (/\b(?:decltype|typeof|__typeof__)\s*$/.test(detail.slice(0, at))) return undefined
            const parameters = parameterList(detail.slice(at))
            return parameters !== undefined && !/^\s*[*&]/.test(parameters) ? parameters : undefined
        }
    }
    return undefined
}

/** A bare name, or return type such as void, does not establish zero parameters.
 * Inspect the original snippet: query($0) and query(${1:}) still reserve an
 * argument slot even though stripping their placeholders produces query().
 */
export function callableParameters(item: LspCompletionItem, name: string): CallableParameters {
    if (!name.trim()) return 'unknown'
    const evidence = [
        item.labelDetails?.detail === undefined ? undefined : parameterList(item.labelDetails.detail),
        namedParameters(item.label, name),
        namedParameters(item.detail, name),
        namedParameters(item.textEdit?.newText ?? item.insertText, name)
    ].filter((value): value is string => value !== undefined)
    // detail is commonly only a return type. Function-type details are a fallback
    // and cannot contradict an actual call signature from the label or insertion.
    if (!evidence.length) {
        const fallback = typeParameters(item.detail)
        if (fallback !== undefined) evidence.push(fallback)
    }
    if (evidence.some((parameters) => !/^\s*(?:void\s*)?$/.test(parameters))) return 'present'
    return evidence.length ? 'empty' : 'unknown'
}
