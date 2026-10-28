import { describe, expect, it } from 'vitest'
import { MIParseError, miQuote, parseMIRecord } from './mi'
import { splitArgs } from '../toolchain/args'

describe('GDB/MI parser', () => {
    it('parses tokens, tuples, value lists and repeated result-list names', () => {
        expect(
            parseMIRecord(
                '123^done,stack=[frame={level="0",func="f",args=[{name="x",value="2"}]},frame={level="1",func="main"}],empty=[]'
            )
        ).toEqual({
            kind: 'result',
            token: 123,
            cls: 'done',
            results: {
                stack: [
                    { frame: { level: '0', func: 'f', args: [{ name: 'x', value: '2' }] } },
                    { frame: { level: '1', func: 'main' } }
                ],
                empty: []
            }
        })
    })
    it('decodes C strings including octal UTF-8, hex, controls and Windows paths', () => {
        expect(parseMIRecord(String.raw`~"\"C:\\work\\a.cpp\"\n\t\303\251\x21\a\b\f\r\v"`)).toEqual({
            kind: 'console',
            text: '"C:\\work\\a.cpp"\n\té!\x07\b\f\r\v'
        })
        expect(parseMIRecord('~"中文😀"')).toEqual({ kind: 'console', text: '中文😀' })
    })
    it('retains repeated tuple keys, including result values that are themselves lists', () => {
        expect(
            parseMIRecord('^done,thread-ids={thread-id="3",thread-id="2",thread-id="1"},x=["a"],x=["b"]')
        ).toMatchObject({
            results: { 'thread-ids': { 'thread-id': ['3', '2', '1'] }, x: [['a'], ['b']] }
        })
    })
    it.each([
        ['*stopped,reason="breakpoint-hit"', 'exec'],
        ['+download,section=".text"', 'status'],
        ['=thread-group-started,id="i1",pid="42"', 'notify'],
        ['&"warning\\n"', 'log'],
        ['@"hello\\n"', 'target']
    ])('parses %s', (line, kind) => {
        expect(parseMIRecord(line).kind).toBe(kind)
    })
    it('handles prompts, errors and non-MI diagnostic lines', () => {
        expect(parseMIRecord('(gdb) \r')).toEqual({ kind: 'prompt' })
        expect(parseMIRecord(String.raw`7^error,msg="No symbol \"x\""`)).toMatchObject({
            kind: 'result',
            token: 7,
            cls: 'error',
            results: { msg: 'No symbol "x"' }
        })
        expect(parseMIRecord('MinGW diagnostic')).toEqual({ kind: 'output', text: 'MinGW diagnostic' })
    })
    it.each(['1^done,a={oops}', '1^done,a="unterminated', '1^done,a=["x",]', '~"ok"junk'])(
        'rejects malformed %s',
        (line) => {
            expect(() => parseMIRecord(line)).toThrow(MIParseError)
        }
    )
    it('quotes MI arguments and splits compiler flags without a shell', () => {
        expect(miQuote('x"\n\\')).toBe('"x\\"\\n\\\\"')
        expect(parseMIRecord(`~${miQuote('\0\x01\x1f中文😀')}`)).toEqual({ kind: 'console', text: '\0\x01\x1f中文😀' })
        expect(splitArgs('-std=c++17 -g -I "D:\\some path\\include" -DNAME=\'hello world\'')).toEqual([
            '-std=c++17',
            '-g',
            '-I',
            'D:\\some path\\include',
            '-DNAME=hello world'
        ])
        expect(() => splitArgs('-I "unfinished')).toThrow('Unclosed quote')
    })
})
