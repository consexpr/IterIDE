// How many lexical tokens a C++ source has: what the completion model reads, minus comments.
// A single pass, no dependencies; close to clang's lexer, which is what the model itself uses.

const PUNCTUATORS = [
    ['<=>', '...', '<<=', '>>=', '->*'],
    [
        '::',
        '->',
        '++',
        '--',
        '<<',
        '>>',
        '<=',
        '>=',
        '==',
        '!=',
        '&&',
        '||',
        '+=',
        '-=',
        '*=',
        '/=',
        '%=',
        '&=',
        '|=',
        '^=',
        '.*',
        '##'
    ]
]
const IDENTIFIER = /[\p{L}_$][\p{L}\p{N}_$]*/uy
const NUMBER = /\.?\d(?:[eEpP][+-]|[\w.'])*/y
const STRING_PREFIX = /(?:u8|u|U|L)?R?(?=["'])/y

export function countTokens(text: string): number {
    let count = 0
    let i = 0
    const n = text.length
    while (i < n) {
        const c = text[i]
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') {
            i++
            continue
        }
        if (c === '/' && text[i + 1] === '/') {
            // A comment runs to the end of its line, unless the line ends with a backslash.
            for (; i < n; i++) {
                if (text[i] !== '\n') continue
                const before = text[i - 1] === '\r' ? i - 2 : i - 1
                if (text[before] !== '\\') break
            }
            continue
        }
        if (c === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2)
            i = end < 0 ? n : end + 2
            continue
        }
        STRING_PREFIX.lastIndex = i
        const prefix = STRING_PREFIX.exec(text)
        if (prefix) {
            const raw = prefix[0].endsWith('R')
            let j = i + prefix[0].length
            const quote = text[j]
            if (raw && quote === '"') {
                const open = text.indexOf('(', j + 1)
                const delimiter = open < 0 ? '' : text.slice(j + 1, open)
                const close = open < 0 ? -1 : text.indexOf(`)${delimiter}"`, open + 1)
                i = close < 0 ? n : close + delimiter.length + 2
            } else {
                j++
                while (j < n && text[j] !== quote && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1
                i = j + 1
            }
            count++
            continue
        }
        IDENTIFIER.lastIndex = i
        const word = IDENTIFIER.exec(text)
        if (word) {
            i += word[0].length
            count++
            continue
        }
        NUMBER.lastIndex = i
        const number = NUMBER.exec(text)
        if (number) {
            i += number[0].length
            count++
            continue
        }
        const length = PUNCTUATORS[0].some((p) => text.startsWith(p, i))
            ? 3
            : PUNCTUATORS[1].some((p) => text.startsWith(p, i))
              ? 2
              : 1
        i += length
        count++
    }
    return count
}
