import { describe, expect, it } from 'vitest'
import { BRACELESS_BODY } from '../editor/cppTokens'
import { CLIENT_CAPABILITY, ITER_LEGEND, classify, remapSemanticTokens } from './semantic'

const mods = (...names: string[]): Set<string> => new Set(names)
const name = (index: number): string => ITER_LEGEND.tokenTypes[index]

describe('semantic token classes', () => {
    it('gives every macro one class and tells locals, parameters, globals and members apart', () => {
        expect(classify('macro', mods())).toBe('macro')
        expect(classify('variable', mods('declaration', 'functionScope'))).toBe('variable.local')
        expect(classify('variable', mods('globalScope'))).toBe('variable.global')
        expect(classify('variable', mods('fileScope', 'declaration'))).toBe('variable.global')
        expect(classify('variable', mods('classScope', 'static'))).toBe('variable.field')
        expect(classify('parameter', mods('functionScope'))).toBe('variable.param')
        expect(classify('field', mods('classScope'))).toBe('variable.field')
        expect(classify('property', mods())).toBe('variable.field')
    })

    it('treats read-only globals as constants but keeps const locals as locals', () => {
        expect(classify('variable', mods('readonly', 'globalScope'))).toBe('constant')
        expect(classify('variable', mods('readonly', 'functionScope'))).toBe('variable.local')
        expect(classify('enumMember', mods())).toBe('constant')
    })

    it('shares colours with the grammar for functions and types, and separates the standard library', () => {
        expect(classify('function', mods())).toBe('function')
        expect(classify('method', mods('classScope'))).toBe('function')
        expect(classify('class', mods())).toBe('type')
        expect(classify('class', mods('defaultLibrary'))).toBe('type.stl')
        expect(classify('namespace', mods('defaultLibrary'))).toBe('type.stl')
        expect(classify('namespace', mods())).toBe('namespace')
        expect(classify('comment', mods())).toBe('comment')
    })

    it('leaves punctuation and unknown kinds to the grammar', () => {
        for (const type of ['operator', 'bracket', 'modifier', 'unknown']) expect(classify(type, mods())).toBeNull()
    })

    it('every class it can return is in the legend', () => {
        const types = [
            'variable',
            'parameter',
            'function',
            'method',
            'property',
            'class',
            'enum',
            'type',
            'enumMember',
            'namespace',
            'label',
            'macro',
            'comment',
            'field'
        ]
        for (const type of types)
            for (const m of [
                mods(),
                mods('functionScope'),
                mods('globalScope'),
                mods('defaultLibrary'),
                mods('readonly', 'fileScope')
            ]) {
                const result = classify(type, m)
                if (result) expect(ITER_LEGEND.tokenTypes).toContain(result)
            }
    })
})

describe('remapping clangd tokens', () => {
    const legend = { tokenTypes: CLIENT_CAPABILITY.tokenTypes, tokenModifiers: CLIENT_CAPABILITY.tokenModifiers }
    const type = (n: string): number => legend.tokenTypes.indexOf(n)
    const bit = (n: string): number => 1 << legend.tokenModifiers.indexOf(n)

    it('translates types and keeps positions, dropping tokens the grammar keeps', () => {
        // line 0: `ls` macro @0, `(` bracket @3 (dropped), `n` local @4 ; line 2: `g` global @2
        const data = [
            0,
            0,
            2,
            type('macro'),
            0,
            0,
            3,
            1,
            type('bracket'),
            0,
            0,
            1,
            1,
            type('variable'),
            bit('functionScope'),
            2,
            2,
            1,
            type('variable'),
            bit('globalScope')
        ]
        const out = remapSemanticTokens(data, legend)
        expect(Array.from(out)).toEqual([0, 0, 2, 5, 0, 0, 4, 1, 6, 0, 2, 2, 1, 8, 0])
        expect(name(out[3])).toBe('macro')
        expect(name(out[8])).toBe('variable.local')
        expect(name(out[13])).toBe('variable.global')
    })

    it('re-bases the delta of the token after a dropped one on a new line', () => {
        const data = [0, 4, 3, type('operator'), 0, 1, 2, 2, type('parameter'), 0]
        expect(Array.from(remapSemanticTokens(data, legend))).toEqual([1, 2, 2, 7, 0])
    })

    it('ignores empty input and out-of-range types', () => {
        expect(remapSemanticTokens([], legend).length).toBe(0)
        expect(remapSemanticTokens([0, 0, 2, 999, 0], legend).length).toBe(0)
    })
})

describe('Enter after a braceless control statement', () => {
    it.each([
        'for(int i=1;i<=n;i++)',
        '    for (int i = 0; i < n; i++)',
        'if (x)',
        '  while (cin >> x)',
        '} else if (a && (b || c))',
        'else',
        '    } else',
        'do',
        'for (;;)  // forever'
    ])('indents the next line after %j', (line) => expect(BRACELESS_BODY.test(line)).toBe(true))

    it.each([
        'for(int i=1;i<=n;i++){',
        'if (x) return;',
        'while (x);',
        'int a = f(x);',
        'for (auto& x : v) sum += x;',
        'return foo(x)',
        '// if (x)',
        'elsewhere',
        'do {'
    ])('leaves %j alone', (line) => expect(BRACELESS_BODY.test(line)).toBe(false))
})
