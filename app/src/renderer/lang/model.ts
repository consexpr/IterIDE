import type * as Monaco from 'monaco-editor'
import type { IterApi } from '../../shared/api'
import { MODEL_REQUEST_TIMEOUT_MS, validModelResult } from '../../shared/model'
import type { Candidate } from './ranking'
import type { LspCompletionItem } from './protocol'
import { recordModelCall, recordModelFailure, recordModelReuse } from './modelStats'

/** The training model receives clangd's first 100, before ITER's display ranking. */
function modelItems(items: LspCompletionItem[]): LspCompletionItem[] {
    return items
        .map((item, index) => ({ item, index }))
        .sort((a, b) => {
            if (a.item.sortText !== undefined && b.item.sortText !== undefined)
                return a.item.sortText < b.item.sortText
                    ? -1
                    : a.item.sortText > b.item.sortText
                      ? 1
                      : a.index - b.index
            return a.index - b.index
        })
        .slice(0, 100)
        .map((entry) => entry.item)
}

/**
 * The model's order from the last real inference at one completion site. While the user keeps typing the
 * same word (`names` -> `namespa`), the list only narrows, so the old order is reused without a model call.
 */
export interface ModelMemory {
    current?: { key: string; prefix: string; names: string[] }
}

const MAX_MODEL_CANDIDATES = 100
const KEYWORD_KIND = 14

/**
 * Reorder every candidate the model can judge: clangd's items and ITER's own keywords (clangd does not
 * offer `false`, `true` or `nullptr` as completions, yet they are exactly what a bool argument wants).
 * They are scored together, so a keyword can beat a class that merely shares its prefix. User snippets
 * and other local items keep their positions.
 */
export async function modelRank(
    api: IterApi,
    candidates: Candidate[],
    items: LspCompletionItem[],
    input: {
        id: string
        source: string
        cursor: number
        prefix: string
        flags: string
    },
    token: Monaco.CancellationToken,
    reuse?: { key: string; memory: ModelMemory }
): Promise<Candidate[]> {
    if (!api.model || token.isCancellationRequested) return candidates
    const bySemantic = new Map<LspCompletionItem, Candidate>()
    for (const candidate of candidates) if (candidate.semantic) bySemantic.set(candidate.semantic, candidate)
    const keywords = candidates.filter((candidate) => !candidate.semantic && candidate.category === 'keyword')
    // clangd's own items keep priority when the list is longer than the model accepts.
    const ordered = modelItems(items).slice(0, MAX_MODEL_CANDIDATES - keywords.length)
    const entries: {
        item: Pick<LspCompletionItem, 'label' | 'kind' | 'filterText' | 'detail' | 'labelDetails' | 'score'>
        candidate?: Candidate
    }[] = [
        ...ordered.map((item) => ({ item, candidate: bySemantic.get(item) })),
        ...keywords.map((candidate) => ({ item: { label: candidate.name, kind: KEYWORD_KIND }, candidate }))
    ]
    const slots = entries.flatMap((entry) => (entry.candidate ? [entry.candidate] : []))
    if (entries.length < 2 || !slots.length) return candidates
    const positions = new Map(entries.map((entry, index) => [entry.candidate, index]))
    const inSlots = new Set(slots)
    const place = (scored: Candidate[]): Candidate[] => {
        let next = 0
        return candidates.map((candidate) => (inSlots.has(candidate) ? scored[next++] : candidate))
    }
    const remembered = reuse?.memory.current
    if (remembered && remembered.key === reuse!.key && input.prefix.startsWith(remembered.prefix)) {
        // Reuse only while the model's favourite is still listed and nothing new appeared; otherwise ask again.
        const known = new Map(remembered.names.map((name, rank) => [name, rank]))
        if (
            slots.every((candidate) => known.has(candidate.name)) &&
            slots.some((candidate) => candidate.name === remembered.names[0])
        ) {
            recordModelReuse()
            return place([...slots].sort((a, b) => known.get(a.name)! - known.get(b.name)!))
        }
    }
    const standard = /(?:^|\s)-std=((?:gnu|c)\+\+(?:98|11|14|17|20|23|26))(?=\s|$)/.exec(input.flags)?.[1] ?? 'gnu++17'
    let timer: ReturnType<typeof setTimeout> | undefined
    const cancel = (): void => {
        try {
            api.model.cancel(input.id)
        } catch {
            /* Closing/preload teardown. */
        }
    }
    const subscription = token.onCancellationRequested(cancel)
    const started = performance.now()
    try {
        const result = await Promise.race([
            api.model
                .rank({
                    ...input,
                    standard,
                    candidates: entries.map(({ item }) => ({
                        label: item.label,
                        kind: item.kind,
                        filterText: item.filterText,
                        detail: item.detail,
                        labelDetails: item.labelDetails,
                        score: item.score
                    }))
                })
                .catch(() => null),
            new Promise<null>((resolve) => {
                timer = setTimeout(() => {
                    cancel()
                    resolve(null)
                }, MODEL_REQUEST_TIMEOUT_MS + 20)
            })
        ])
        if (token.isCancellationRequested) return candidates
        if (!validModelResult(result, entries.length)) {
            recordModelFailure()
            return candidates
        }
        recordModelCall(performance.now() - started)
        const ranks = new Map(result.order.map((index, rank) => [index, rank]))
        const scored = [...slots].sort((a, b) => ranks.get(positions.get(a)!)! - ranks.get(positions.get(b)!)!)
        if (reuse)
            reuse.memory.current = {
                key: reuse.key,
                prefix: input.prefix,
                names: scored.map((candidate) => candidate.name)
            }
        return place(scored)
    } catch {
        recordModelFailure()
        return candidates
    } finally {
        clearTimeout(timer)
        subscription.dispose()
    }
}
