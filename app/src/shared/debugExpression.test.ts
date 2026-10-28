import { expect, it } from 'vitest'
import { isReadOnlyDebugExpression } from './debugExpression'

it.each([
    'a+b',
    'A[i+1]',
    'obj.member',
    'p->member',
    '::g[2]',
    '(a+b)*2',
    '(int)a[9]',
    '(unsigned long long) value',
    'a ? b : c',
    'sizeof(a)',
    '!flag && value >= 2',
    '*p',
    "0xffULL + 'x'"
])('accepts automatic inspection of %s', (expression) => {
    expect(isReadOnlyDebugExpression(expression)).toBe(true)
})
it.each([
    '',
    'a=2',
    'a+=2',
    '++a',
    'a--',
    'new int',
    'delete p',
    'f()',
    '(f)(x)',
    'obj.f()',
    'a,b',
    'a; b',
    '(Custom)a',
    'static_cast<int>(a)',
    'a/*hidden*/+b',
    'a\n=2',
    '('.repeat(100) + 'a' + ')'.repeat(100),
    'a'.repeat(4097)
])('rejects calls, mutations and excessive input: %s', (expression) => {
    expect(isReadOnlyDebugExpression(expression)).toBe(false)
})
