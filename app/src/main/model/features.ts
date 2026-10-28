import type { ModelCandidate, ModelRequest, ModelResult } from '../../shared/model'
import caseFolds from './casefold.generated.json'

export interface LexicalToken {
    kind: number
    start: number
    end: number
}
export interface FeatureArrays {
    context_bytes: BigInt64Array
    context_kinds: BigInt64Array
    candidate_bytes: BigInt64Array
    candidate_kinds: BigInt64Array
    features: Float32Array
    candidate_mask: Uint8Array
    /** Only fed to models that declare it. Definition: ITER-completion-trainer `file_stats.py`. */
    file_stats: Float32Array
}
const folds: Record<string, string> = caseFolds
const caseFold = (text: string): string => [...text].map((char) => folds[char] ?? char.toLowerCase()).join('')
const points = (text: string): number => [...text].length

export function candidateName(item: ModelCandidate): string {
    const text = (item.filterText || item.label).trim()
    if (item.kind === 17 || item.kind === 19) return text.replace(/[>"/]+$/, '')
    return text.split('(', 1)[0].split('<', 1)[0].trim().split('::').at(-1) ?? ''
}

const AFTER_TYPE = new Set(['>', '&', '*', '&&'])
const DECLARATION_NEXT = new Set(['=', ';', ',', '(', '[', '{'])

/**
 * File-wide occurrence statistics, eight numbers per candidate (the last two are reserved zeros).
 * Comments and literals never count; neither does the word being typed. Distances are in tokens.
 * Must stay identical to `file_stats()` in the trainer: the golden fixtures compare the bytes.
 */
export function fileStats(
    source: Buffer,
    tokens: readonly LexicalToken[],
    cursor: number,
    prefix: string,
    names: readonly string[]
): Float32Array {
    const code = tokens.filter((token) => token.kind !== 4)
    const spelling = (token: LexicalToken): string => source.subarray(token.start, token.end).toString('utf8')
    let leftCount = 0
    for (const token of code) if (token.end <= cursor) leftCount++
    const typed = prefix !== '' && leftCount > 0 && code[leftCount - 1].end === cursor ? leftCount - 1 : -1
    // Aggregate once per spelling. Repeated/overloaded candidates reuse these statistics,
    // rather than allocating and filtering occurrence arrays for every candidate row.
    interface Occurrences {
        count: number
        left: number
        firstLeft: number
        lastLeft: number
        firstRight: number
        outside: boolean
    }
    const positions = new Map<string, Occurrences>()
    const wanted = new Set(names)
    code.forEach((token, index) => {
        if (token.kind === 3 || index === typed) return
        const word = spelling(token)
        if (!wanted.has(word)) return
        let known = positions.get(word)
        if (!known) {
            known = { count: 0, left: 0, firstLeft: -1, lastLeft: -1, firstRight: -1, outside: false }
            positions.set(word, known)
        }
        known.count++
        if (index < leftCount) {
            if (!known.left) known.firstLeft = index
            known.left++
            known.lastLeft = index
        } else if (known.firstRight < 0) known.firstRight = index
        known.outside ||= index < leftCount - 128 || index >= leftCount + 32
    })
    const declarationLike = (index: number): boolean => {
        if (index === 0 || index + 1 >= code.length) return false
        const previous = code[index - 1]
        return (
            (previous.kind === 1 || previous.kind === 2 || AFTER_TYPE.has(spelling(previous))) &&
            DECLARATION_NEXT.has(spelling(code[index + 1]))
        )
    }
    const result = new Float32Array(names.length * 8)
    names.forEach((name, row) => {
        const hits = positions.get(name)
        if (!hits) return
        result.set(
            [
                Math.log1p(hits.count) / 5,
                Math.log1p(hits.left) / 5,
                hits.left ? 1 / (leftCount - hits.lastLeft) : 0,
                hits.firstRight >= 0 ? 1 / (1 + hits.firstRight - leftCount) : 0,
                Number(hits.outside),
                Number(hits.left > 0 && declarationLike(hits.firstLeft)),
                0,
                0
            ],
            row * 8
        )
    })
    return result
}

/** Byte-for-byte equivalent of the frozen trainer's FeatureConfig(192, 48, 256). */
export function featureArrays(request: ModelRequest, tokens: readonly LexicalToken[]): FeatureArrays {
    const source = Buffer.from(request.source, 'utf8')
    const cursor = Buffer.byteLength(request.source.slice(0, request.cursor), 'utf8')
    const count = request.candidates.length
    const arrays: FeatureArrays = {
        context_bytes: new BigInt64Array(192 * 48),
        context_kinds: new BigInt64Array(192),
        candidate_bytes: new BigInt64Array(count * 256),
        candidate_kinds: new BigInt64Array(count),
        features: new Float32Array(count * 8),
        candidate_mask: new Uint8Array(count).fill(1),
        file_stats: new Float32Array(0)
    }
    const left = tokens.filter((token) => token.kind !== 4 && token.end <= cursor).slice(-128)
    const right = tokens.filter((token) => token.kind !== 4 && token.start >= cursor).slice(0, 32)
    const context = [...left, { kind: 5, start: cursor, end: cursor }, ...right]
    const put = (target: BigInt64Array, offset: number, text: string, limit: number): void => {
        const bytes = Buffer.from(text, 'utf8')
        for (let i = 0; i < Math.min(bytes.length, limit); i++) target[offset + i] = BigInt(bytes[i] + 1)
    }
    for (const [i, token] of context.entries()) {
        arrays.context_kinds[i] = BigInt(token.kind + 1)
        put(
            arrays.context_bytes,
            i * 48,
            token.kind === 5
                ? '<cursor>'
                : token.kind === 3
                  ? '<literal>'
                  : source.subarray(token.start, token.end).toString('utf8'),
            48
        )
    }
    const prefix = request.prefix,
        foldedPrefix = caseFold(prefix)
    request.candidates.forEach((item, index) => {
        const name = candidateName(item),
            foldedName = caseFold(name)
        put(
            arrays.candidate_bytes,
            index * 256,
            `${name}\n${item.labelDetails?.detail ?? ''}\n${item.detail ?? ''}`,
            256
        )
        arrays.candidate_kinds[index] = BigInt(item.kind ?? 0)
        const score = item.score ?? 0
        arrays.features.set(
            [
                1 / (index + 1),
                score / (1 + Math.abs(score)),
                Math.min(points(prefix), 64) / 64,
                Math.min(points(name), 128) / 128,
                Number(name.startsWith(prefix)),
                Number(foldedName.startsWith(foldedPrefix)),
                Number(foldedName.includes(foldedPrefix)),
                Number(name === prefix)
            ],
            index * 8
        )
    })
    arrays.file_stats = fileStats(source, tokens, cursor, prefix, request.candidates.map(candidateName))
    return arrays
}

export function probabilities(scores: ArrayLike<number>): ModelResult {
    const values = Array.from(scores)
    if (!values.length || values.some((score) => !Number.isFinite(score))) throw Error('Invalid Model scores')
    const maximum = Math.max(...values)
    const weights = values.map((score) => Math.exp(score - maximum)),
        total = weights.reduce((sum, p) => sum + p, 0)
    return {
        order: values.map((_, index) => index).sort((a, b) => values[b] - values[a] || a - b),
        probabilities: weights.map((weight) => weight / total)
    }
}
