import { describe, expect, it } from 'vitest'
import { evaluateCaptured } from './expression'
import type { ValueNode } from './trace'
const scalar = (name: string, value: string, bits = 32, signed = true): ValueNode => ({
    name,
    value,
    type: 'int',
    hasChildren: false,
    scalar: { kind: 'int', value, bits, signed }
})
const locals: ValueNode[] = [
    scalar('i', '3'),
    scalar('big', '9007199254740993', 64),
    scalar('u', '4294967295', 32, false),
    {
        name: 'a',
        value: '{...}',
        hasChildren: true,
        truncated: true,
        indexable: true,
        children: [
            scalar('[0]', '7'),
            { name: '[1]', value: '{...}', hasChildren: true, indexable: true, children: [scalar('[0]', '11')] }
        ]
    },
    { name: 'obj', value: '{x=8}', hasChildren: true, children: [scalar('x', '8')] },
    { name: 'd', value: '1.5', hasChildren: false, scalar: { kind: 'float', value: '1.5', bits: 64, signed: true } }
]
describe('exact captured expressions', () => {
    it.each([
        ['i*2+1', '7'],
        ['big+2', '9007199254740995'],
        ['a[0]+a[1][0]', '18'],
        ['obj.x%3', '2'],
        ['i>=3 && !(i==4)', 'true'],
        ['false && missing', 'false'],
        ['true || a[999]', 'true'],
        ["'a'+1", '98'],
        ["'\\n'+1", '11'],
        ['u+1', '0'],
        ['d/2', '0.75'],
        ['0x10+010+0b10', '26'],
        ['::g+1', '21'],
        ['-7/3', '-2'],
        ['-7%3', '-1'],
        ['u < -1', 'false'],
        ['-0.0', '-0'],
        ['0.0 * -1.0', '-0']
    ])('%s = %s', (expression, result) => {
        expect(evaluateCaptured(expression, locals, [scalar('::g', '20')])?.value).toBe(result)
    })
    it.each([
        'a[99]',
        'a[-1]',
        'unknown',
        'i()',
        'i=9',
        'i++',
        '++i',
        '--i',
        'reinterpret_cast<int>(i)',
        '2147483647+1',
        '1/0',
        '0xffffffff < -1',
        '037777777777 < -1',
        '1L',
        '0.1f + 0.2f'
    ])('delegates %s without guessing', (expression) => {
        expect(evaluateCaptured(expression, locals, [])).toBeUndefined()
    })
})
