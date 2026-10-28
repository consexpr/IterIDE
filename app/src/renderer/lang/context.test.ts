import { describe, expect, it } from 'vitest'
import { completionContext } from './context'

const context = (text: string) => completionContext(text, text.length)
describe('C++ completion contexts', () => {
    it('recognizes header path segments, including dots, without leaking onto a finished directive', () => {
        expect(context('#include<bits/stdc++.h')).toMatchObject({ access: 'include', prefix: 'stdc++.h' })
        expect(context('# include "my/head')).toMatchObject({ access: 'include', prefix: 'head' })
        expect(context('#include<bits/stdc++.h>')).toMatchObject({ access: 'none' })
        expect(context('#incl')).toMatchObject({ access: 'none' })
        expect(context('// #include <head')).toMatchObject({ access: 'none' })
        expect(context('/*\n#include <head')).toMatchObject({ access: 'none' })
    })
    it('suppresses strings, characters, raw strings and multiline comments', () => {
        for (const text of [
            '// value',
            '/*\nvalue',
            '"value',
            "'v",
            'R"tag(a "\nvalue',
            'u8R"tag(a "\nvalue',
            'u"value',
            "L'v"
        ]) {
            expect(context(text).access, text).toBe('none')
        }
        expect(context('"closed"; value').access).toBe('plain')
        expect(context('/* closed */ value').access).toBe('plain')
        expect(context('R"tag(a "\nvalue)tag"; value').access).toBe('plain')
        expect(context("1'000; value").access).toBe('plain')
    })
    it('recognizes access through whitespace/comments and after multiline expressions', () => {
        expect(context('vec. pu')).toMatchObject({ access: 'member', prefix: 'pu' })
        expect(context('vec->/* note */\npu')).toMatchObject({ access: 'member', prefix: 'pu' })
        expect(context('std::so')).toMatchObject({ access: 'scope', prefix: 'so' })
    })
})
