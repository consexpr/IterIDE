import type { Variable } from '../../shared/debug'
import { miList, miQuote, miString, miTuple, type MITuple } from './mi'

export const SUMMARY_LIMIT = 199
const ELEMENTS = 10
const FIELDS = 6
const containerType =
    /^std::(?:__\w+::)*(?:vector|deque|list|forward_list|set|multiset|unordered_set|unordered_multiset|array|initializer_list|map|multimap|unordered_map|unordered_multimap|stack|queue|priority_queue)\s*</
const accessGroup = (tuple: MITuple): boolean =>
    !miString(tuple.type) && /^(public|protected|private)$/.test(miString(tuple.exp))
const childCount = (tuple: MITuple): number => Number(miString(tuple.numchild)) || 0
export const hasChildren = (tuple: MITuple): boolean =>
    childCount(tuple) > 0 ||
    miString(tuple.has_more) === '1' ||
    (miString(tuple.dynamic) === '1' && /^(array|map)$/.test(miString(tuple.displayhint)))

export function shortenValue(text: string, limit = SUMMARY_LIMIT): string {
    const line = text.replace(/[\r\n\t]+/g, ' ')
    if (line.length <= limit) return line
    let end = limit - 1
    if (/[\uD800-\uDBFF]/.test(line[end - 1] ?? '')) end--
    return line.slice(0, end) + '…'
}

interface Kind {
    style: 'sequence' | 'map' | 'array' | 'struct'
    length?: number
}
function kindOf(tuple: MITuple): Kind | undefined {
    const hint = miString(tuple.displayhint),
        type = miString(tuple.type),
        value = miString(tuple.value)
    if (hint === 'string') return undefined
    if (hint === 'map') return { style: 'map' }
    if (hint === 'array' || (miString(tuple.dynamic) === '1' && containerType.test(type))) return { style: 'sequence' }
    const array = /\[(\d+)\]/.exec(type)
    if (array && !/\(\s*\*[^)]*\)\s*\[/.test(type)) return { style: 'array', length: Number(array[1]) }
    // Pointers keep their address while remaining expandable through their ref.
    if (/\*\s*(?:(?:const|volatile)\s*)*$/.test(type)) return undefined
    if (hasChildren(tuple) || /^\{(?:\.\.\.)?\}$/.test(value)) return { style: 'struct' }
    return undefined
}

/** Read previews from the same var objects used by the expansion UI. */
export class ValueSummaries {
    private readonly cache = new Map<string, string>()
    constructor(private readonly command: (command: string) => Promise<MITuple>) {}

    clear(): void {
        this.cache.clear()
    }
    forget(ref: string): void {
        for (const key of this.cache.keys()) if (key === ref || key.startsWith(`${ref}.`)) this.cache.delete(key)
    }

    async variable(tuple: MITuple, name?: string, expression?: string): Promise<Variable> {
        const expandable = hasChildren(tuple)
        const raw = miString(tuple.value) || (expandable ? '{...}' : '')
        const ref = miString(tuple.name)
        return {
            name: name ?? miString(tuple.exp),
            value: kindOf(tuple)
                ? await this.summary(tuple, 0, { remaining: 16 }, expression).catch(() => shortenValue(raw))
                : raw.slice(0, 16_384),
            type: miString(tuple.type) || undefined,
            hasChildren: expandable,
            ref: expandable ? ref : undefined
        }
    }

    private async preview(
        ref: string,
        count: number,
        budget: { remaining: number }
    ): Promise<{ children: MITuple[]; more: boolean; hint: string }> {
        if (budget.remaining-- <= 0) return { children: [], more: true, hint: '' }
        const result = await this.command(`-var-list-children --all-values ${miQuote(ref)} 0 ${count}`)
        return {
            children: miList(result.children).map((child) => miTuple(miTuple(child).child)),
            more: miString(result.has_more) === '1' || childCount(result) > count,
            hint: miString(result.displayhint)
        }
    }

    private async summary(
        tuple: MITuple,
        depth: number,
        budget: { remaining: number },
        expression?: string
    ): Promise<string> {
        const ref = miString(tuple.name),
            kind = kindOf(tuple)
        if (!kind) return shortenValue(miString(tuple.value), depth ? 48 : SUMMARY_LIMIT)
        const cached = this.cache.get(ref)
        if (cached !== undefined) return cached
        if (depth >= 2 || budget.remaining <= 0 || !ref) return '{…}'
        const limit = kind.style === 'struct' ? FIELDS : ELEMENTS
        const preview = await this.preview(ref, (limit + 1) * (kind.style === 'map' ? 2 : 1), budget)
        let children = preview.children
        let more = preview.more
        if (kind.style === 'struct') {
            const fields: MITuple[] = []
            for (const child of children) {
                if (fields.length > limit) {
                    more = true
                    break
                }
                if (accessGroup(child)) {
                    const group = await this.preview(miString(child.name), limit + 1 - fields.length, budget)
                    fields.push(...group.children)
                    more ||= group.more
                } else fields.push(child)
            }
            children = fields
        }
        const count = children.length / (kind.style === 'map' ? 2 : 1)
        more ||= count > limit
        // A fully fetched preview also gives the exact size when it contains the
        // eleventh item. Discover larger totals before nested previews use the budget.
        const size =
            kind.style === 'sequence' || kind.style === 'map'
                ? preview.more
                    ? await this.containerSize(ref, expression, budget, count)
                    : count
                : undefined
        const parts: string[] = []
        const render = (child: MITuple): Promise<string> =>
            this.summary(child, depth + 1, budget).catch(() => shortenValue(miString(child.value) || '{…}', 48))
        if (kind.style === 'map') {
            for (let i = 0; i < Math.min(children.length, limit * 2); i += 2) {
                parts.push(`${await render(children[i])}→${children[i + 1] ? await render(children[i + 1]) : '…'}`)
            }
        } else {
            for (const child of children.slice(0, limit)) {
                const value = await render(child)
                parts.push(kind.style === 'struct' ? `${miString(child.exp)}=${value}` : value)
            }
        }
        if (more) parts.push('…')
        let prefix = ''
        if (kind.style === 'array') prefix = `[${kind.length ?? childCount(tuple)}] `
        else if (kind.style !== 'struct') {
            prefix = size === undefined ? `size≥${Math.floor(count)} ` : `size=${size} `
        }
        const text = shortenValue(`${prefix}{${parts.join(', ')}}`)
        // Shallow nested previews should not replace a richer root preview later.
        if (depth === 0) this.cache.set(ref, text)
        return text
    }

    private async containerSize(
        ref: string,
        expression: string | undefined,
        budget: { remaining: number },
        minimum: number
    ): Promise<number | undefined> {
        try {
            if (budget.remaining-- <= 0) return undefined
            if (!expression)
                expression = miString((await this.command(`-var-info-path-expression ${miQuote(ref)}`)).path_expr)
            // Size discovery only re-reads an lvalue: never invoke a hover function
            // again. GDB's existing print-elements cap bounds the printer's output.
            const lvalue = expression?.replace(/[\s()]/g, '') ?? ''
            if (
                !expression ||
                /\w\s*\(|\)\s*\(/.test(expression) ||
                !/^\**[A-Za-z_$][\w$]*(?:(?:\.|->)[A-Za-z_]\w*|\[(?:\d+|[A-Za-z_]\w*)\])*$/.test(lvalue)
            )
                return undefined
            const result = await this.command(`-data-evaluate-expression ${miQuote(expression)}`)
            // Only the printer header describes this container; a nested element's
            // length must not become the outer container's size (e.g. list<vector<T>>).
            const header = miString(result.value).split(/\s*=\s*\{/)[0]
            const match = /\blength\s+(\d+)|\bwith\s+(\d+)\s+elements?|\bsize\s*=\s*(\d+)/.exec(header)
            const size = match ? Number(match[1] ?? match[2] ?? match[3]) : undefined
            return size !== undefined && Number.isSafeInteger(size) && size >= minimum ? size : undefined
        } catch {
            return undefined
        }
    }
}
