import { expect, it } from 'vitest'
import { splitArgs } from './args'

it('preserves Windows drive, UNC and trailing directory backslashes', () => {
    expect(
        splitArgs(String.raw`-I C:\work\include -I \\server\share\inc -I "D:\my headers\inc"` + ' C:\\tail\\', 'win32')
    ).toEqual([
        '-I',
        String.raw`C:\work\include`,
        '-I',
        String.raw`\\server\share\inc`,
        '-I',
        String.raw`D:\my headers\inc`,
        'C:\\tail\\'
    ])
})
it('retains empty arguments and literal quotes without shell expansion', () => {
    expect(splitArgs(String.raw`"" '' -DMSG=\"hello\" -DNAME='hello world' $(ignored)`, 'win32')).toEqual([
        '',
        '',
        '-DMSG="hello"',
        '-DNAME=hello world',
        '$(ignored)'
    ])
    expect(splitArgs(String.raw`path\ with\ spaces back\\slash`, 'linux')).toEqual(['path with spaces', 'back\\slash'])
})
it.each(['-I "unfinished', "-DNAME='unfinished"])('rejects unclosed quotes: %s', (input) => {
    expect(() => splitArgs(input)).toThrow('Unclosed quote')
})
