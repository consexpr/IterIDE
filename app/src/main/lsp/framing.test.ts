import { describe, expect, it } from 'vitest'
import { frameMessage, LspMessageParser } from './framing'
import { splitArgs } from '../toolchain/args'

describe('stdio framing', () => {
    it('handles byte-by-byte headers, bodies and UTF-8', () => {
        const received: unknown[] = []
        const parser = new LspMessageParser((message) => received.push(message))
        const message = { jsonrpc: '2.0', id: 1, result: '中文 😀' }
        for (const byte of frameMessage(message)) parser.push(Buffer.from([byte]))
        expect(received).toEqual([message])
    })
    it('handles concatenated frames, optional headers and malformed JSON', () => {
        const received: unknown[] = []
        const parser = new LspMessageParser((message) => received.push(message))
        parser.push(
            Buffer.concat([
                Buffer.from('Content-Length: 1\r\n\r\nx'),
                frameMessage({ a: 1 }),
                Buffer.from('Content-Type: application/vscode-jsonrpc; charset=utf-8\r\ncontent-length: 2\r\n\r\n{}')
            ])
        )
        expect(received).toEqual([{ a: 1 }, {}])
    })
    it('bounds invalid headers and recovers on the next chunk', () => {
        const received: unknown[] = []
        const parser = new LspMessageParser((message) => received.push(message))
        parser.push(Buffer.from('Content-Length: 9999999999\r\n\r\n'))
        parser.push(frameMessage({ ok: true }))
        expect(received).toEqual([{ ok: true }])
    })
    it('rejects oversized complete headers and ambiguous lengths, then recovers', () => {
        for (const header of [
            'X-Padding: ' + 'x'.repeat(8192) + '\r\nContent-Length: 2\r\n\r\n{}',
            'Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}',
            'Content-Length: -1\r\n\r\n'
        ]) {
            const received: unknown[] = []
            const parser = new LspMessageParser((message) => received.push(message))
            parser.push(Buffer.from(header))
            expect(received).toEqual([])
            parser.push(frameMessage({ ok: true }))
            expect(received).toEqual([{ ok: true }])
        }
    })
    it('preserves large fragmented Unicode replies followed by a second frame', () => {
        const received: unknown[] = []
        const parser = new LspMessageParser((message) => received.push(message))
        const message = { result: '补全😀'.repeat(100_000) }
        const bytes = Buffer.concat([frameMessage(message), frameMessage({ id: 2 })])
        for (let offset = 0; offset < bytes.length; offset += 113) parser.push(bytes.subarray(offset, offset + 113))
        expect(received).toEqual([message, { id: 2 }])
    })
    it('ignores an empty or malformed body without swallowing the following frame', () => {
        const received: unknown[] = []
        const parser = new LspMessageParser((message) => received.push(message))
        parser.push(Buffer.from('Content-Length: 0\r\n\r\n'))
        parser.push(frameMessage({ ok: true }))
        expect(received).toEqual([{ ok: true }])
    })
})

it('splits quoted flags without consuming Windows backslashes or executing anything', () => {
    expect(splitArgs('-std=c++20 -I"D:\\my headers\\inc" -DMSG=\'hello world\' -Wall')).toEqual([
        '-std=c++20',
        '-ID:\\my headers\\inc',
        '-DMSG=hello world',
        '-Wall'
    ])
})
