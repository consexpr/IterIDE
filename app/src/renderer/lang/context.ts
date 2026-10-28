export type AccessKind = 'plain' | 'member' | 'scope' | 'include' | 'none'
/**
 * `name`: the word being typed follows a complete type (`int n`, `vector<int> v` is not detected, `Node n`),
 * so it can only be a new name and no keyword fits. `type`: it follows a type keyword that another type
 * keyword may continue (`unsigned lo` -> `long`). Undefined: anything else.
 */
export type NamingPosition = 'name' | 'type' | undefined

export interface CompletionContext {
    prefix: string
    access: AccessKind
    offset: number
    start: number
    following: string
    naming?: NamingPosition
    /** The word being typed directly follows `using`. */
    afterUsing?: boolean
}

const TYPE_KEYWORDS = new Set([
    'int',
    'long',
    'short',
    'char',
    'double',
    'float',
    'bool',
    'void',
    'auto',
    'signed',
    'unsigned',
    'wchar_t',
    'char8_t',
    'char16_t',
    'char32_t'
])
/** Type keywords that another type keyword or qualifier may follow (`long long`, `unsigned int`, `int const`). */
const TYPE_CONTINUABLE = new Set(['int', 'long', 'short', 'char', 'double', 'signed', 'unsigned'])
/** Keywords after which an identifier is an expression, a type or a label, not a new name. */
const NOT_A_TYPE_WORD = new Set(
    'return else case goto new delete throw sizeof alignof typeid typename template using namespace class struct union enum const constexpr consteval constinit volatile static extern inline mutable register thread_local typedef operator co_await co_return co_yield decltype noexcept not and or xor bitand bitor compl true false this nullptr do virtual explicit friend public private protected default try catch if while for switch'.split(
        ' '
    )
)

/** Text before the word being typed -> whether that word can only be a fresh name. */
export function namingPosition(codeBeforeWord: string): NamingPosition {
    const match = /([A-Za-z_][A-Za-z_0-9]*)\s+$/.exec(codeBeforeWord)
    if (!match) return undefined
    const word = match[1]
    if (TYPE_KEYWORDS.has(word)) return TYPE_CONTINUABLE.has(word) ? 'type' : 'name'
    if (NOT_A_TYPE_WORD.has(word)) return undefined
    // Two identifiers in a row cannot be an expression: the first is a type, the second a new name.
    return 'name'
}

/** A small lexer, used only for suppression and the offline word fallback, never semantics. */
export function codeMask(text: string): { code: string; inLiteralOrComment: boolean } {
    let code = '',
        i = 0,
        blocked = false
    const mask = (part: string): string => part.replace(/[^\r\n]/g, ' ')
    while (i < text.length) {
        const start = i
        if (text.startsWith('//', i)) {
            const end = text.indexOf('\n', i + 2)
            i = end < 0 ? text.length : end
            blocked = end < 0
        } else if (text.startsWith('/*', i)) {
            const end = text.indexOf('*/', i + 2)
            i = end < 0 ? text.length : end + 2
            blocked = end < 0
        } else if (/^(?:u8|u|U|L)?R"/.test(text.slice(i, i + 4)) && !/[\w]/.test(text[i - 1] ?? '')) {
            const opening = /^(?:u8|u|U|L)?R"([^\s()\\]{0,16})\(/.exec(text.slice(i))
            if (!opening) {
                code += text[i++]
                continue
            }
            const end = text.indexOf(`)${opening[1]}"`, i + opening[0].length)
            i = end < 0 ? text.length : end + opening[1].length + 2
            blocked = end < 0
        } else if (
            text[i] === '"' ||
            (text[i] === "'" && !/[\w]/.test(text[i - 1] ?? '')) ||
            (/^(?:u8|u|U|L)'/.test(text.slice(i, i + 4)) && !/[\w]/.test(text[i - 1] ?? ''))
        ) {
            while (text[i] !== '"' && text[i] !== "'") i++
            const quote = text[i++]
            blocked = true
            while (i < text.length) {
                if (text[i] === '\\') {
                    i = Math.min(text.length, i + 2)
                    continue
                }
                if (text[i++] === quote) {
                    blocked = false
                    break
                }
            }
        } else {
            code += text[i++]
            continue
        }
        code += mask(text.slice(start, i))
    }
    return { code, inLiteralOrComment: blocked }
}

export function completionContext(text: string, offset: number): CompletionContext {
    const before = text.slice(0, offset)
    const masked = codeMask(before)
    const lineStart = before.lastIndexOf('\n') + 1
    const line = before.slice(lineStart)
    const directive = /^\s*#\s*([a-z_]*)\b/i.exec(line)
    const plainPrefix = /[A-Za-z_0-9]*$/.exec(before)![0]
    const result: CompletionContext = {
        prefix: plainPrefix,
        access: 'plain',
        offset,
        start: offset - plainPrefix.length,
        following: text.slice(offset)
    }
    // Check the '#' in the mask: a directive-looking string/comment is not an include.
    if (directive && masked.code[lineStart + line.indexOf('#')] === '#') {
        const header = /^\s*#\s*(?:include|include_next|import)\s*[<"]([^>"\r\n]*)$/.exec(line)
        if (header) {
            const prefix = header[1].split(/[\\/]/).pop()!
            return { ...result, access: 'include', prefix, start: offset - prefix.length }
        }
        return { ...result, access: 'none' }
    }
    if (masked.inLiteralOrComment) return { ...result, access: 'none' }
    const codeBeforeWord = masked.code.slice(0, result.start)
    if (/(?:\.|->)\s*$/.test(codeBeforeWord)) result.access = 'member'
    else if (/::\s*$/.test(codeBeforeWord)) result.access = 'scope'
    else if (result.prefix && !/^\d/.test(result.prefix)) {
        result.naming = namingPosition(codeBeforeWord)
        result.afterUsing = /(?:^|[^\w])using\s+$/.test(codeBeforeWord)
    }
    return result
}
