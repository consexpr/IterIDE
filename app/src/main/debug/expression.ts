import type { ExactScalar, ValueNode } from './trace'

/** This evaluator only consumes captured numeric data. Everything else goes to
 * GDB; display summaries are deliberately never parsed as computational data. */
type Expr = { op: string; text?: string; args: Expr[] }
const unknown = (): never => {
    throw new Error('Requires GDB')
}
const precedence: Record<string, number> = {
    '||': 1,
    '&&': 2,
    '==': 3,
    '!=': 3,
    '<': 4,
    '>': 4,
    '<=': 4,
    '>=': 4,
    '+': 5,
    '-': 5,
    '*': 6,
    '/': 6,
    '%': 6
}
export function parseExpression(source: string): Expr {
    const tokens: string[] = []
    let rest = source
    while (rest.trim()) {
        const match =
            /^\s*(::[a-zA-Z_]\w*(?:::\w+)*|[a-zA-Z_]\w*(?:::\w+)*|(?:0[xX][\da-fA-F]+|0[bB][01]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)[uUlLfF]*|'(?:[^'\\]|\\(?:[abfnrtv\\'"?]|[0-7]{1,3}|x[\da-fA-F]+))'|\+\+|--|&&|\|\||==|!=|<=|>=|[+*/%<>()!\[\].-])/.exec(
                rest
            )
        if (!match) unknown()
        tokens.push(match![1])
        rest = rest.slice(match![0].length)
    }
    let i = 0
    function parse(min = 0): Expr {
        const token = tokens[i++]
        if (!token) return unknown()
        let left: Expr
        if (['!', '+', '-'].includes(token)) left = { op: token + 'u', args: [parse(7)] }
        else if (token === '(') {
            left = parse()
            if (tokens[i++] !== ')') unknown()
        } else if (/^(?:::)?[a-zA-Z_]/.test(token)) left = { op: 'name', text: token, args: [] }
        else if (/^[\d.']/.test(token)) left = { op: 'literal', text: token, args: [] }
        else return unknown()
        while (i < tokens.length) {
            const op = tokens[i]
            if (op === '[') {
                i++
                const index = parse()
                if (tokens[i++] !== ']') unknown()
                left = { op: 'index', args: [left, index] }
                continue
            }
            if (op === '.') {
                i++
                const name = tokens[i++]
                if (!/^[a-zA-Z_]\w*$/.test(name ?? '')) unknown()
                left = { op: 'member', text: name, args: [left] }
                continue
            }
            const p = precedence[op]
            if (p === undefined || p < min) break
            i++
            left = { op, args: [left, parse(p + 1)] }
        }
        return left
    }
    const ast = parse()
    if (i !== tokens.length) unknown()
    return ast
}
const int = (n: bigint, bits = 32, signed = true): ExactScalar => ({ kind: 'int', value: String(n), bits, signed })
const bool = (b: boolean): ExactScalar => int(b ? 1n : 0n, 1, false)
const floatText = (n: number): string => (Object.is(n, -0) ? '-0' : String(n))
const truth = (s: ExactScalar): boolean => (s.kind === 'int' ? BigInt(s.value) !== 0n : Number(s.value) !== 0)
function promote(s: ExactScalar): ExactScalar {
    return s.kind === 'int' && s.bits < 32 ? int(BigInt(s.value)) : s
}
function literal(text: string): ExactScalar {
    if (text.startsWith("'")) {
        let c = text.slice(1, -1)
        const escapes: Record<string, number> = {
            a: 7,
            b: 8,
            f: 12,
            n: 10,
            r: 13,
            t: 9,
            v: 11,
            '\\': 92,
            "'": 39,
            '"': 34,
            '?': 63
        }
        const n = c.startsWith('\\x')
            ? parseInt(c.slice(2), 16)
            : /^\\[0-7]/.test(c)
              ? parseInt(c.slice(1), 8)
              : c.startsWith('\\')
                ? escapes[c.slice(1)]
                : c.codePointAt(0)
        if (n === undefined || n > 127) return unknown() // implementation-defined char encoding
        return int(BigInt(n), 8)
    }
    if (/[.eE]/.test(text) && !/^0x/i.test(text)) {
        if (/[lLfF]$/.test(text)) return unknown() // avoid decimal -> double -> float double rounding
        const bits = 64
        const n = Number(text.replace(/[fF]$/, ''))
        if (!Number.isFinite(n)) return unknown()
        return { kind: 'float', value: floatText(n), bits, signed: true }
    }
    const suffix = /[uUlL]+$/.exec(text)?.[0] ?? ''
    const raw = text.slice(0, text.length - suffix.length)
    const n = BigInt(/^0[0-7]+$/.test(raw) ? '0o' + raw.slice(1) : raw)
    // Unsuffixed hex/octal has target-specific type selection; delegate when large.
    if (!suffix && /^0(?:[xb]|[0-7])/i.test(raw) && n > 2147483647n) return unknown()
    const bits = /ll/i.test(suffix) || n > (/u/i.test(suffix) ? 4294967295n : 2147483647n) ? 64 : 32
    if (/l/i.test(suffix) && !/ll/i.test(suffix)) return unknown() // Windows/Linux long differs
    if (n >= 1n << BigInt(bits - (/u/i.test(suffix) ? 0 : 1))) return unknown()
    return int(n, bits, !/u/i.test(suffix))
}
export function evaluateCaptured(
    source: string,
    locals: ValueNode[],
    globals: ValueNode[]
): { scalar?: ExactScalar; node?: ValueNode; value: string; type?: string } | undefined {
    try {
        const ast = parseExpression(source)
        function node(e: Expr): ValueNode {
            if (e.op === 'name') {
                const n =
                    (e.text!.startsWith('::') ? [] : locals).find((n) => n.name === e.text) ??
                    globals.find((n) => n.name === (e.text!.startsWith('::') ? e.text : '::' + e.text))
                if (!n || n.unavailable) return unknown()
                return n
            }
            const parent = node(e.args[0])
            if (e.op === 'index') {
                const sub = scalar(e.args[1])
                if (!parent.indexable || sub.kind !== 'int') return unknown()
                const index = BigInt(sub.value)
                if (index < 0n || index > BigInt(Number.MAX_SAFE_INTEGER)) return unknown()
                return parent.children?.[Number(index)] ?? unknown()
            }
            if (e.op === 'member') return parent.children?.find((n) => n.name === e.text) ?? unknown()
            return unknown()
        }
        function scalar(e: Expr): ExactScalar {
            if (e.op === 'literal') return literal(e.text!)
            if (e.op === 'name' && ['true', 'false'].includes(e.text!)) return bool(e.text === 'true')
            if (['name', 'index', 'member'].includes(e.op)) return node(e).scalar ?? unknown()
            const a = promote(scalar(e.args[0]))
            if (e.op === '!u') return bool(!truth(a))
            if (e.op === '+u') return a
            if (e.op === '-u')
                return a.kind === 'float' ? { ...a, value: floatText(-Number(a.value)) } : calculate('-', int(0n), a)
            if (e.op === '&&' && !truth(a)) return bool(false)
            if (e.op === '||' && truth(a)) return bool(true)
            return calculate(e.op, a, promote(scalar(e.args[1])))
        }
        function calculate(op: string, a: ExactScalar, b: ExactScalar): ExactScalar {
            if (op === '&&') return bool(truth(a) && truth(b))
            if (op === '||') return bool(truth(a) || truth(b))
            let x: bigint | number, y: bigint | number
            const floating = a.kind === 'float' || b.kind === 'float'
            const bits = floating
                ? Math.max(a.kind === 'float' ? a.bits : 0, b.kind === 'float' ? b.bits : 0)
                : Math.max(a.bits, b.bits)
            if (
                floating &&
                bits === 32 &&
                (op === '/' || (a.kind === 'int' && a.bits > 32) || (b.kind === 'int' && b.bits > 32))
            )
                return unknown()
            const signed = a.signed === b.signed ? a.signed : a.signed ? a.bits > b.bits : b.bits > a.bits
            if (floating) {
                x = Number(a.value)
                y = Number(b.value)
                if (bits === 32) {
                    x = Math.fround(x)
                    y = Math.fround(y)
                }
            } else {
                const cast = (s: ExactScalar): bigint =>
                    signed ? BigInt(s.value) : BigInt.asUintN(bits, BigInt(s.value))
                x = cast(a)
                y = cast(b)
            }
            if (['==', '!=', '<', '<=', '>', '>='].includes(op))
                return bool(
                    op === '=='
                        ? x === y
                        : op === '!='
                          ? x !== y
                          : op === '<'
                            ? x < y
                            : op === '<='
                              ? x <= y
                              : op === '>'
                                ? x > y
                                : x >= y
                )
            if ((op === '/' || op === '%') && (y === 0n || y === 0)) return unknown()
            let result: bigint | number
            if (typeof x === 'number' && typeof y === 'number') {
                if (op === '%') return unknown()
                result = op === '+' ? x + y : op === '-' ? x - y : op === '*' ? x * y : x / y
                if (bits === 32) result = Math.fround(result)
                if (!Number.isFinite(result)) return unknown()
                return { kind: 'float', value: floatText(result), bits, signed: true }
            }
            if (typeof x !== 'bigint' || typeof y !== 'bigint') return unknown()
            result = op === '+' ? x + y : op === '-' ? x - y : op === '*' ? x * y : op === '/' ? x / y : x % y
            if (signed && (result < -(1n << BigInt(bits - 1)) || result >= 1n << BigInt(bits - 1))) return unknown()
            return int(signed ? result : BigInt.asUintN(bits, result), bits, signed)
        }
        if (['name', 'index', 'member'].includes(ast.op) && !['true', 'false'].includes(ast.text ?? '')) {
            const n = node(ast)
            if (n.unavailable) return unknown()
            return { node: n, scalar: n.scalar, value: n.value, type: n.type }
        }
        const s = scalar(ast)
        // Width alone does not distinguish ABI-dependent long/long long/typedefs.
        // Do not invent a type for computed numeric expressions.
        return {
            scalar: s,
            value: s.bits === 1 ? (truth(s) ? 'true' : 'false') : s.value,
            type: s.bits === 1 ? 'bool' : undefined
        }
    } catch {
        return undefined
    }
}
