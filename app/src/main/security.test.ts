import { describe, expect, it } from 'vitest'
import { externalUrl, sameDocument, trustedSender } from './security'

describe('renderer privilege boundary', () => {
    const entry = 'file:///C:/ITER/renderer/index.html'
    it('accepts the application main frame and fragment navigation', () => {
        const frame = { url: entry + '#settings' }
        const contents = { mainFrame: frame, isDestroyed: () => false }
        expect(trustedSender({ sender: contents, senderFrame: frame } as any, contents as any, entry)).toBe(true)
    })
    it('rejects a plugin window, subframe, destroyed frame and navigated editor', () => {
        const frame = { url: entry }
        const contents = { mainFrame: frame, isDestroyed: () => false }
        for (const event of [
            { sender: {}, senderFrame: frame },
            { sender: contents, senderFrame: { url: entry } },
            { sender: contents, senderFrame: null }
        ])
            expect(trustedSender(event as any, contents as any, entry)).toBe(false)
        frame.url = 'https://example.com/'
        expect(trustedSender({ sender: contents, senderFrame: frame } as any, contents as any, entry)).toBe(false)
        expect(trustedSender({} as any, null, entry)).toBe(false)
    })
    it('matches the exact dev entry instead of a prefix or a shared file origin', () => {
        expect(sameDocument('http://localhost:5173/#settings', 'http://localhost:5173/')).toBe(true)
        for (const url of [
            'http://localhost:5173/other',
            'http://localhost:5173.evil.test/',
            'http://localhost:5173/?evil',
            'not a URL'
        ]) {
            expect(sameDocument(url, 'http://localhost:5173/')).toBe(false)
        }
        expect(sameDocument('file:///C:/untrusted.html', entry)).toBe(false)
    })
})

describe('external web links', () => {
    it.each([
        'https://github.com/login/device',
        'http://localhost:3000/test?q=hello%20world',
        'https://例子.测试/题目'
    ])('accepts %s', (url) => {
        expect(externalUrl(url)).toBe(new URL(url).href)
    })
    it.each([
        'file:///C:/Windows/System32/calc.exe',
        'javascript:alert(1)',
        'data:text/html,test',
        'ms-settings:privacy',
        'https://user:password@example.com/',
        'https://example.com/\n',
        '//example.com',
        '',
        null
    ])('rejects %s', (url) => {
        expect(() => externalUrl(url)).toThrow()
    })
})
