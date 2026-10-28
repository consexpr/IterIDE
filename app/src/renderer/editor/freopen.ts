// Keeps problem File-IO config and the code's freopen calls consistent.

export interface FreopenNames {
    input?: string
    output?: string
}

interface Token {
    kind: 'name' | 'string' | 'other'
    value: string
}
interface Branch {
    parent: boolean
    active: boolean
    remaining: boolean
}

/** Only literal 0/1 conditions are evaluated. Unknown macro conditions leave
 * all potentially reachable branches visible; this is not a C++ preprocessor. */
function constantCondition(expression: string): boolean | undefined {
    let value = expression
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/.*$/, '')
        .trim()
    while (/^\([^()]*\)$/.test(value)) value = value.slice(1, -1).trim()
    if (/^0[uUlL]*$/.test(value)) return false
    if (/^1[uUlL]*$/.test(value)) return true
    return undefined
}

function decodeEscapes(value: string): string {
    const escapes: Record<string, string> = {
        a: '\x07',
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t',
        v: '\v',
        '\\': '\\',
        '"': '"',
        "'": "'",
        '?': '?'
    }
    return value.replace(
        /\\(x[\da-fA-F]+|u[\da-fA-F]{4}|U[\da-fA-F]{8}|[0-7]{1,3}|[\s\S])/g,
        (match, escape: string) => {
            if (escape in escapes) return escapes[escape]
            const radix = /^[0-7]/.test(escape) ? 8 : /^[xuU]/.test(escape) ? 16 : 0
            if (!radix) return match
            const point = Number.parseInt(radix === 8 ? escape : escape.slice(1), radix)
            return point <= 0x10ffff ? String.fromCodePoint(point) : match
        }
    )
}

/** Tokenize before matching calls so comments and literal contents can never
 * introduce identifiers. Preserve filenames as decoded string tokens. */
function tokens(code: string): Token[] {
    // C++ joins escaped physical lines before recognizing comments/tokens.
    const source = code.replace(/\\\r?\n/g, '')
    const result: Token[] = [],
        branches: Branch[] = []
    const active = (): boolean => branches.at(-1)?.active ?? true
    const literal = /(?:u8|[uUL])?(?:R"|["'])/y
    let i = 0,
        lineStart = true
    while (i < source.length) {
        const c = source[i]
        if (/\s/.test(c)) {
            if (c === '\n') lineStart = true
            i++
            continue
        }
        if (source.startsWith('//', i)) {
            const end = source.indexOf('\n', i + 2)
            i = end < 0 ? source.length : end
            continue
        }
        if (source.startsWith('/*', i)) {
            const close = source.indexOf('*/', i + 2),
                end = close < 0 ? source.length : close + 2
            if (source.slice(i, end).includes('\n')) lineStart = true
            i = end
            continue
        }
        if (lineStart && c === '#') {
            const end = source.indexOf('\n', i),
                line = source.slice(i, end < 0 ? source.length : end)
            const directive = /^#\s*(if|ifdef|ifndef|elif|else|endif)\b([\s\S]*)$/.exec(line)
            if (directive) {
                const [, name, expression] = directive
                if (name === 'if' || name === 'ifdef' || name === 'ifndef') {
                    const parent = active(),
                        condition = name === 'if' ? constantCondition(expression) : undefined
                    branches.push({ parent, active: parent && condition !== false, remaining: condition !== true })
                } else if (name === 'endif') branches.pop()
                else {
                    const branch = branches.at(-1)
                    if (branch) {
                        const condition = name === 'else' ? true : constantCondition(expression)
                        branch.active = branch.parent && branch.remaining && condition !== false
                        if (condition === true) branch.remaining = false
                    }
                }
            }
            // Definitions/includes are not executed calls. Macro expansion belongs to
            // the compiler, so do not inspect freopen text inside any directive.
            i = end < 0 ? source.length : end
            continue
        }
        lineStart = false
        literal.lastIndex = i
        const start = literal.exec(source)
        if (start) {
            let value = '',
                end = literal.lastIndex
            const quote = start[0].at(-1)!,
                raw = start[0].endsWith('R"')
            if (raw) {
                const open = source.indexOf('(', end),
                    delimiter = source.slice(end, open)
                if (open >= 0 && /^[^\s()\\]{0,16}$/.test(delimiter)) {
                    const marker = `)${delimiter}"`,
                        close = source.indexOf(marker, open + 1)
                    value = source.slice(open + 1, close < 0 ? source.length : close)
                    end = close < 0 ? source.length : close + marker.length
                } else end = source.length // An unfinished raw literal owns its remaining text.
            } else {
                const from = end
                while (end < source.length && source[end] !== quote && source[end] !== '\n') {
                    if (source[end] === '\\' && end + 1 < source.length) end += 2
                    else end++
                }
                value = decodeEscapes(source.slice(from, end))
                if (source[end] === quote) end++
            }
            if (active()) result.push({ kind: quote === '"' ? 'string' : 'other', value })
            i = end
            continue
        }
        const name = /^[\p{ID_Start}_$][\p{ID_Continue}$]*/u.exec(source.slice(i))
        if (name) {
            if (active()) result.push({ kind: 'name', value: name[0] })
            i += name[0].length
            continue
        }
        const punctuation = source.startsWith('::', i) ? '::' : source.startsWith('->', i) ? '->' : c
        if (active()) result.push({ kind: 'other', value: punctuation })
        i += punctuation.length
    }
    return result
}

export function detectFreopen(code: string): FreopenNames {
    const src = tokens(code),
        out: FreopenNames = {}
    for (let i = 0; i < src.length; i++) {
        if (src[i].kind !== 'name' || src[i].value !== 'freopen' || src[i + 1]?.value !== '(') continue
        let begin = i
        while (src[begin - 1]?.value === '::' && src[begin - 2]?.kind === 'name') begin -= 2
        if (src[begin - 1]?.value === '::') begin--
        const qualifier = src
            .slice(begin, i)
            .map((token) => token.value)
            .join('')
        if (!['', '::', 'std::', '::std::'].includes(qualifier) || ['.', '->'].includes(src[begin - 1]?.value)) continue
        let at = i + 2
        const readString = (): string | undefined => {
            if (src[at]?.kind !== 'string') return undefined
            let value = ''
            while (src[at]?.kind === 'string') value += src[at++].value
            return value
        }
        const file = readString()
        if (!file || src[at++]?.value !== ',') continue
        const mode = readString()
        if (!mode || !/^[rwa](?:[bt]\+?|\+[bt]?)?$/.test(mode) || src[at++]?.value !== ',') continue
        const stream = src[at++]
        if (stream?.kind !== 'name' || src[at]?.value !== ')') continue
        if (stream.value === 'stdin' && !out.input) out.input = file
        if (stream.value === 'stdout' && !out.output) out.output = file
    }
    return out
}

/** Insert freopen lines at the top of main() (after the opening brace). Returns null if main is not found. */
export function insertFreopen(code: string, input: string, output: string): string | null {
    const m = /\bint\s+main\s*\([^)]*\)\s*\{[^\n]*\n/.exec(code)
    if (!m) return null
    const at = m.index + m[0].length
    const indent = /^([ \t]*)\S/m.exec(code.slice(at))?.[1] ?? '    '
    const lines = `${indent}freopen("${input}", "r", stdin);\n${indent}freopen("${output}", "w", stdout);\n`
    return code.slice(0, at) + lines + code.slice(at)
}
