import { codeMask, type CompletionContext } from './context'
import { CPP_KEYWORDS, DEFAULT_COMPLETION_OPTIONS, type CompletionOptions } from './options'
import type { LspCompletionItem } from './protocol'
import type { CompletionUsageStore } from './usage'
import { escapeSnippetText, inspectSnippet, plainCompletionText, validUserSnippet } from './snippet'
import { callableParameters, type CallableParameters } from './callable'

export type { CompletionContext } from './context'
export type CompletionCategory =
    | 'keyword'
    | 'type'
    | 'function'
    | 'variable'
    | 'constant'
    | 'snippet'
    | 'member'
    | 'property'
    | 'file'
    | 'folder'
export interface Identifier {
    name: string
    offsets: number[]
}
export interface Candidate {
    name: string
    insertText: string
    filterText: string
    category: CompletionCategory
    scope: number
    order: number
    match: number
    usageKey: string
    detail?: string
    snippet?: boolean
    semantic?: LspCompletionItem
}

/** Used only while clangd is unavailable; comments and literals do not contribute words. */
export function indexIdentifiers(text: string): Identifier[] {
    const words = new Map<string, number[]>()
    for (const match of codeMask(text).code.matchAll(/\b[A-Za-z_][A-Za-z_0-9]*\b/g)) {
        const offsets = words.get(match[0])
        if (offsets) offsets.push(match.index)
        else words.set(match[0], [match.index])
    }
    return [...words].map(([name, offsets]) => ({ name, offsets }))
}

function visible(name: string, prefix: string, options: CompletionOptions): boolean {
    if (prefix.startsWith('_')) return true
    // _Uppercase is reserved to the implementation in C++, independently of the user _lowercase setting.
    if (/^_[A-Z]/.test(name)) return false
    return (
        !(options.hideSymbolsStartsWithUnderLine && name.startsWith('_')) &&
        !(options.hideSymbolsStartsWithTwoUnderLine && name.startsWith('__'))
    )
}

function matchQuality(name: string, prefix: string, ignoreCase: boolean): number {
    if (name.startsWith(prefix)) return name === prefix ? 0 : 1
    const haystack = ignoreCase ? name.toLowerCase() : name
    const needle = ignoreCase ? prefix.toLowerCase() : prefix
    if (haystack.startsWith(needle)) return 2
    let at = 0
    for (const c of needle) {
        at = haystack.indexOf(c, at)
        if (at < 0) return Infinity
        at++
    }
    return 3
}

function candidate(
    name: string,
    category: CompletionCategory,
    context: CompletionContext,
    options: CompletionOptions
): Candidate {
    return {
        name,
        category,
        insertText: name,
        filterText:
            options.ignoreCase && name.toLowerCase().startsWith(context.prefix.toLowerCase())
                ? context.prefix + name.slice(context.prefix.length)
                : name,
        scope: 3,
        order: 0,
        match: matchQuality(name, context.prefix, options.ignoreCase),
        usageKey: `${category}:${name}`
    }
}

const TYPE_CONTINUATION = new Set(['int', 'long', 'short', 'char', 'double', 'signed', 'unsigned', 'const', 'volatile'])

/** The only non-semantic items allowed online are language keywords and explicit user snippets. */
export function supplementalCandidates(context: CompletionContext, options: CompletionOptions): Candidate[] {
    if (context.access !== 'plain' || !context.prefix) return []
    const result: Candidate[] = []
    // A keyword never names a variable: after a complete type only `long`, `unsigned`... can still follow.
    if (options.showKeywords && context.naming !== 'name')
        for (const name of CPP_KEYWORDS) {
            if (context.naming === 'type' && !TYPE_CONTINUATION.has(name)) continue
            const item = candidate(name, 'keyword', context, options)
            if (item.match <= 2) result.push(item)
        }
    for (const snippet of options.snippets) {
        const prefix = options.ignoreCase ? context.prefix.toLowerCase() : context.prefix
        const trigger = options.ignoreCase ? snippet.trigger.toLowerCase() : snippet.trigger
        if (!trigger || !prefix.startsWith(trigger) || !validUserSnippet(snippet.body)) continue
        const inspected = inspectSnippet(snippet.body)
        result.push({
            ...candidate(snippet.trigger, 'snippet', context, options),
            filterText: context.prefix,
            match: 0,
            insertText: inspected.tabStops.length ? snippet.body : inspected.text,
            snippet: inspected.tabStops.length > 0,
            detail: snippet.detail
        })
    }
    return result
}

export function fallbackCandidates(
    context: CompletionContext,
    identifiers: Identifier[],
    options: CompletionOptions
): Candidate[] {
    if (context.access !== 'plain' || !context.prefix) return []
    const keywords = new Set(CPP_KEYWORDS)
    const words = identifiers
        .filter(
            ({ name, offsets }) =>
                !keywords.has(name) &&
                visible(name, context.prefix, options) &&
                !(offsets.length === 1 && offsets[0] === context.start)
        )
        .map(({ name }, index) => ({
            ...candidate(name, 'variable', context, options),
            scope: 2,
            order: index,
            detail: 'Document word (clangd unavailable)'
        }))
        .filter((item) => item.match <= 2)
    return [...supplementalCandidates(context, options), ...words]
}

export function completionName(item: LspCompletionItem): string {
    if (item.kind === 17 || item.kind === 19) return (item.filterText || item.label).trim().replace(/[>"]$/, '')
    const label = (item.filterText || item.label).trim().replace(/\(.*$/s, '').replace(/<.*$/s, '').trim()
    return label.split('::').pop() || label
}

function scopeRank(item: LspCompletionItem): number {
    const hint = typeof item.context === 'string' ? item.context : (item.context?.kind ?? item.context?.scope ?? '')
    if (/\b(local|parameter|argument|function)\b/i.test(hint)) return 0
    if (/\b(member|class|struct)\b/i.test(hint) || [2, 5, 10].includes(item.kind ?? 0)) return 1
    if (/\b(same[-_ ]?file|current[-_ ]?file|file)\b/i.test(hint)) return 2
    // clangd uses Variable for both locals and globals. Its sortText breaks that tie.
    if (item.kind === 6) return 0
    return 3
}

export function semanticCandidates(
    items: LspCompletionItem[],
    context: CompletionContext,
    options: CompletionOptions = DEFAULT_COMPLETION_OPTIONS
): Candidate[] {
    if (context.access === 'none') return []
    // Overloads are displayed once by rankCandidates. Only move outside the call
    // when every available overload is known to have no fillable parameters.
    const parameters = new Map<string, CallableParameters>()
    for (const item of items) {
        if (![2, 3, 4].includes(item.kind ?? 0)) continue
        const name = completionName(item),
            next = callableParameters(item, name),
            previous = parameters.get(name)
        parameters.set(
            name,
            previous === 'present' || next === 'present'
                ? 'present'
                : previous === 'unknown' || next === 'unknown'
                  ? 'unknown'
                  : 'empty'
        )
    }
    // sortText is clangd's score/order, not alphabetical symbol order. Preserve input order on ties.
    const ordered = items
        .map((item, index) => ({ item, index }))
        .sort((a, b) => {
            if (a.item.sortText !== undefined && b.item.sortText !== undefined)
                return a.item.sortText < b.item.sortText
                    ? -1
                    : a.item.sortText > b.item.sortText
                      ? 1
                      : a.index - b.index
            if (a.item.score !== undefined && b.item.score !== undefined)
                return b.item.score - a.item.score || a.index - b.index
            return a.index - b.index
        })
    const result: Candidate[] = []
    for (const { item } of ordered) {
        if (item.kind === 15) continue // Only explicitly configured user snippets are offered.
        if (context.access === 'include' && item.kind !== 17 && item.kind !== 19) continue
        if (context.access !== 'plain' && item.kind === 14) continue
        if (!options.showKeywords && (item.kind === 14 || CPP_KEYWORDS.includes(item.label))) continue
        const name = completionName(item)
        const entry = candidate(name, 'variable', context, options)
        if (!Number.isFinite(entry.match) || (context.access !== 'include' && !visible(name, context.prefix, options)))
            continue
        const callable = [2, 3, 4].includes(item.kind ?? 0)
        const rawInsert = plainCompletionText(
            item.textEdit?.newText ?? item.insertText ?? name,
            item.insertTextFormat,
            name
        )
        const functionName = rawInsert.split('(')[0].trim() || name
        const append = callable && options.appendFunc && !/^\s*\(/.test(context.following)
        // Keep a single final stop; server argument placeholders stay discarded.
        // Confirmed zero-parameter calls put that stop after the closing parenthesis.
        const snippet = append
        const category: CompletionCategory =
            item.kind === 17
                ? 'file'
                : item.kind === 19
                  ? 'folder'
                  : item.kind === 14
                    ? 'keyword'
                    : callable
                      ? item.kind === 2
                          ? 'member'
                          : 'function'
                      : [7, 8, 13, 22, 25].includes(item.kind ?? 0)
                        ? 'type'
                        : [20, 21].includes(item.kind ?? 0)
                          ? 'constant'
                          : [5, 10].includes(item.kind ?? 0)
                            ? 'property'
                            : 'variable'
        result.push({
            ...entry,
            category,
            usageKey: `${category}:${name}`,
            scope: scopeRank(item),
            order: result.length,
            insertText: callable
                ? append
                    ? `${escapeSnippetText(functionName)}${parameters.get(name) === 'empty' ? '()$0' : '($0)'}`
                    : functionName
                : rawInsert,
            snippet,
            semantic: item,
            detail: [item.detail, item.labelDetails?.detail ?? (item.label.trim() !== name ? item.label.trim() : '')]
                .filter(Boolean)
                .join(' ')
        })
    }
    return result
}

/** `using na` is almost always `using namespace`, whatever else shares the prefix. */
export function pinSyntax(candidates: Candidate[], context: CompletionContext): Candidate[] {
    if (!context.afterUsing) return candidates
    const index = candidates.findIndex((item) => item.category === 'keyword' && item.name === 'namespace')
    if (index <= 0) return candidates
    return [candidates[index], ...candidates.slice(0, index), ...candidates.slice(index + 1)]
}

/** Scope > acceptance frequency > match quality; clangd's order is the stable base. */
export function rankCandidates(
    supplemental: Candidate[],
    semantic: Candidate[],
    options: CompletionOptions = DEFAULT_COMPLETION_OPTIONS,
    usage?: Pick<CompletionUsageStore, 'frequency'>
): Candidate[] {
    const byName = new Map<string, Candidate>()
    for (const item of [...semantic, ...supplemental]) {
        const key = item.category === 'snippet' ? `snippet:${item.name}` : item.name
        const previous = byName.get(key)
        if (!previous) byName.set(key, item)
        // Retain the best server rank while collecting a useful overload signature.
        else if (previous.semantic && item.semantic && !previous.detail && item.detail)
            byName.set(key, { ...item, order: previous.order, scope: previous.scope })
    }
    const sorted = [...byName.values()].sort(
        (a, b) =>
            (options.sortByScope ? a.scope - b.scope : 0) ||
            (options.recordUsage ? (usage?.frequency(b.usageKey) ?? 0) - (usage?.frequency(a.usageKey) ?? 0) : 0) ||
            a.match - b.match ||
            Number(!a.semantic) - Number(!b.semantic) ||
            a.order - b.order
    )
    return sorted
}
