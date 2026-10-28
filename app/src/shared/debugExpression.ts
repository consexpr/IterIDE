/** Automatic inspections accept a bounded C++ expression subset. Native GDB
 * also disables inferior calls; explicit watch evaluation has its own API. */
export function isReadOnlyDebugExpression(source: string): boolean {
    if (!source.trim() || source.length > 4096) return false
    const tokens: string[] = []
    const pattern =
        /\s*(::|->|&&|\|\||==|!=|<=|>=|<<|>>|[a-zA-Z_]\w*|(?:0[xX][\da-fA-F]+|0[bB][01]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)[uUlLfF]*|'(?:[^'\\\r\n]|\\.)'|[+*/%<>&|^~!()[\].?:-])/y
    let offset = 0
    while (offset < source.length) {
        if (!source.slice(offset).trim()) break
        pattern.lastIndex = offset
        const match = pattern.exec(source)
        if (!match || tokens.length >= 1024) return false
        tokens.push(match[1])
        offset = pattern.lastIndex
    }
    if (
        tokens.some((t) =>
            [
                'new',
                'delete',
                'throw',
                'co_await',
                'co_yield',
                'asm',
                '__asm',
                'static_cast',
                'dynamic_cast',
                'reinterpret_cast',
                'const_cast'
            ].includes(t)
        )
    )
        return false
    // Adjacent unary operators otherwise allow ++/-- to masquerade as signs.
    if (/\+\+|--/.test(source)) return false
    const priorities: Record<string, number> = {
        '||': 1,
        '&&': 2,
        '|': 3,
        '^': 4,
        '&': 5,
        '==': 6,
        '!=': 6,
        '<': 7,
        '<=': 7,
        '>': 7,
        '>=': 7,
        '<<': 8,
        '>>': 8,
        '+': 9,
        '-': 9,
        '*': 10,
        '/': 10,
        '%': 10
    }
    const types = new Set([
        'const',
        'volatile',
        'signed',
        'unsigned',
        'short',
        'long',
        'int',
        'char',
        'wchar_t',
        'char8_t',
        'char16_t',
        'char32_t',
        'bool',
        'float',
        'double',
        'void'
    ])
    let index = 0,
        depth = 0
    const name = (): boolean => {
        if (tokens[index] === '::') ++index
        if (!/^[a-zA-Z_]\w*$/.test(tokens[index] ?? '')) return false
        ++index
        while (tokens[index] === '::') {
            index++
            if (!/^[a-zA-Z_]\w*$/.test(tokens[index] ?? '')) return false
            ++index
        }
        return true
    }
    const expression = (minimum = 0): boolean => {
        if (++depth > 64) return false
        const token = tokens[index++]
        if (!token) return false
        if (['+', '-', '!', '~', '*', '&', 'sizeof', 'alignof'].includes(token)) {
            if (!expression(11)) return false
        } else if (token === '(') {
            const start = index
            while (types.has(tokens[index])) ++index
            const builtin = index > start
            if (builtin) while (tokens[index] === '*') ++index
            if (builtin && tokens[index] === ')') {
                ++index
                if (!expression(11)) return false
            } else {
                index = start
                if (!expression() || tokens[index++] !== ')') return false
            }
        } else if (/^(?:\d|\.|')/.test(token)) {
            /* literal */
        } else {
            --index
            if (!name()) return false
        }
        while (index < tokens.length) {
            const op = tokens[index]
            if (op === '[') {
                ++index
                if (!expression() || tokens[index++] !== ']') return false
                continue
            }
            if (op === '.' || op === '->') {
                ++index
                if (!name()) return false
                continue
            }
            if (op === '?' && minimum === 0) {
                ++index
                if (!expression() || tokens[index++] !== ':' || !expression()) return false
                continue
            }
            const priority = priorities[op]
            if (priority === undefined || priority < minimum) break
            ++index
            if (!expression(priority + 1)) return false
        }
        --depth
        return true
    }
    return expression() && index === tokens.length
}
