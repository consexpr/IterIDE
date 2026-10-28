import { describe, expect, it, vi } from 'vitest'
import { completionContext, namingPosition } from './context'
import { modelRank, type ModelMemory } from './model'
import { DEFAULT_COMPLETION_OPTIONS } from './options'
import { pinSyntax, supplementalCandidates, type Candidate } from './ranking'

describe('naming position', () => {
    it('recognises a fresh name after a complete type', () => {
        expect(namingPosition('    int ')).toBe('type')
        expect(namingPosition('    unsigned ')).toBe('type')
        expect(namingPosition('    void ')).toBe('name')
        expect(namingPosition('    Node ')).toBe('name')
        expect(namingPosition('    std::string ')).toBe('name')
    })

    it('does not treat expressions, labels and type-expecting keywords as naming', () => {
        for (const before of [
            'return ',
            'else ',
            'case ',
            'new ',
            'const ',
            'using namespace ',
            'cout << ',
            'x = ',
            'f(',
            ''
        ]) {
            expect(namingPosition(before), before).toBeUndefined()
        }
    })

    it('is computed from the code before the word, ignoring comments and strings', () => {
        expect(completionContext('int n', 5).naming).toBe('type')
        expect(completionContext('// int n', 8).naming).toBeUndefined()
        expect(completionContext('x.size', 6).naming).toBeUndefined()
        expect(completionContext('f(1, n', 6).naming).toBeUndefined()
    })

    it('offers no keyword for a new name, only type keywords after a type keyword', () => {
        const options = { ...DEFAULT_COMPLETION_OPTIONS, showKeywords: true }
        expect(supplementalCandidates(completionContext('void f(Node n', 13), options)).toEqual([])
        expect(supplementalCandidates(completionContext('int n', 5), options).map((item) => item.name)).toEqual([])
        expect(supplementalCandidates(completionContext('unsigned lo', 11), options).map((item) => item.name)).toEqual([
            'long'
        ])
        expect(supplementalCandidates(completionContext('f(fal', 5), options).map((item) => item.name)).toContain(
            'false'
        )
    })
})

describe('using na', () => {
    it('pins namespace first after `using`', () => {
        const options = { ...DEFAULT_COMPLETION_OPTIONS, showKeywords: true }
        const context = completionContext('using na', 8)
        expect(context.afterUsing).toBe(true)
        expect(completionContext('x = na', 6).afterUsing).toBe(false)
        const keyword = supplementalCandidates(context, options).find((item) => item.name === 'namespace')!
        const nano = { ...keyword, name: 'nano', category: 'type' } as Candidate
        expect(pinSyntax([nano, keyword], context).map((item) => item.name)).toEqual(['namespace', 'nano'])
    })
})

describe('model ranking includes keywords', () => {
    const candidate = (name: string, category: Candidate['category'], semantic?: object): Candidate =>
        ({
            name,
            category,
            insertText: name,
            filterText: name,
            scope: 3,
            order: 0,
            match: 1,
            usageKey: `${category}:${name}`,
            semantic
        }) as Candidate
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as never

    it('lets the model put a keyword ahead of clangd items', async () => {
        const falseType = { label: 'false_type', kind: 22 }
        const future = { label: 'future_already_retrieved', kind: 7 }
        const candidates = [
            candidate('false_type', 'type', falseType),
            candidate('future_already_retrieved', 'type', future),
            candidate('false', 'keyword'),
            candidate('fori', 'snippet')
        ]
        const rank = vi.fn(async (request: { candidates: { label: string }[] }) => {
            // The model prefers whatever is called `false`.
            const labels = request.candidates.map((item) => item.label)
            const order = [labels.indexOf('false'), ...labels.map((_, i) => i).filter((i) => labels[i] !== 'false')]
            return { order, probabilities: labels.map((label) => (label === 'false' ? 0.9 : 0.05)) }
        })
        const memory: ModelMemory = {}
        const result = await modelRank(
            { model: { rank, cancel: vi.fn(), warmup: vi.fn() } } as never,
            candidates,
            [falseType, future] as never,
            { id: 'x', source: 'f(fal', cursor: 5, prefix: 'fal', flags: '-std=c++17' },
            token,
            { key: 'k', memory }
        )
        expect(rank.mock.calls[0][0].candidates.map((item) => item.label)).toEqual([
            'false_type',
            'future_already_retrieved',
            'false'
        ])
        expect(result.map((item) => item.name)).toEqual(['false', 'false_type', 'future_already_retrieved', 'fori'])
    })
})
