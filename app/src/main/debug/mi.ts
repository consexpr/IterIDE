/** GDB/MI values retain result-list wrappers (e.g. stack=[frame={...}]). */
export type MIValue = string | MITuple | MIValue[]
export interface MITuple {
    [key: string]: MIValue
}
export type MIRecord =
    | { kind: 'result' | 'exec' | 'status' | 'notify'; token?: number; cls: string; results: MITuple }
    | { kind: 'console' | 'target' | 'log' | 'output'; text: string }
    | { kind: 'prompt' }

export class MIParseError extends Error {}

class Reader {
    pos = 0
    private readonly duplicates = new WeakMap<MITuple, Set<string>>()
    constructor(readonly input: string) {}
    peek(): string {
        return this.input[this.pos] ?? ''
    }
    fail(): never {
        throw new MIParseError(`Invalid MI at column ${this.pos}: ${this.input.slice(0, 250)}`)
    }
    expect(char: string): void {
        if (this.input[this.pos++] !== char) this.fail()
    }
    word(): string {
        const start = this.pos
        while (/[\w.\-]/.test(this.peek()) && this.peek()) this.pos++
        if (start === this.pos) this.fail()
        return this.input.slice(start, this.pos)
    }
    cstring(): string {
        this.expect('"')
        const bytes: number[] = []
        while (this.pos < this.input.length) {
            let char = this.input[this.pos++]
            if (char === '"') return Buffer.from(bytes).toString('utf8')
            if (char !== '\\') {
                const code = this.input.codePointAt(this.pos - 1)!
                if (code > 0xffff) {
                    char += this.input[this.pos++]
                }
                bytes.push(...Buffer.from(char))
                continue
            }
            char = this.input[this.pos++] ?? this.fail()
            const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, e: 27 }
            if (char in escapes) bytes.push(escapes[char])
            else if (/[0-7]/.test(char)) {
                let octal = char
                for (let i = 0; i < 2 && /[0-7]/.test(this.peek()) && this.peek(); i++) octal += this.input[this.pos++]
                bytes.push(parseInt(octal, 8) & 255)
            } else if (char === 'x') {
                let hex = ''
                while (/[\da-f]/i.test(this.peek()) && this.peek()) hex += this.input[this.pos++]
                if (!hex) this.fail()
                bytes.push(parseInt(hex, 16) & 255)
            } else bytes.push(...Buffer.from(char))
        }
        return this.fail()
    }
    result(target: MITuple): void {
        const key = this.word()
        this.expect('=')
        const value = this.value()
        if (Object.prototype.hasOwnProperty.call(target, key)) {
            let repeated = this.duplicates.get(target)
            if (!repeated) {
                repeated = new Set()
                this.duplicates.set(target, repeated)
            }
            if (repeated.has(key)) (target[key] as MIValue[]).push(value)
            else {
                target[key] = [target[key], value]
                repeated.add(key)
            }
        } else Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true })
    }
    value(): MIValue {
        if (this.peek() === '"') return this.cstring()
        if (this.peek() === '{') {
            this.pos++
            const tuple: MITuple = {}
            while (this.peek() !== '}') {
                this.result(tuple)
                if (this.peek() !== ',') break
                this.pos++
                if (this.peek() === '}') this.fail()
            }
            this.expect('}')
            return tuple
        }
        if (this.peek() === '[') {
            this.pos++
            const list: MIValue[] = []
            while (this.peek() !== ']') {
                if (this.peek() === '"' || this.peek() === '{' || this.peek() === '[') list.push(this.value())
                else {
                    const result: MITuple = {}
                    this.result(result)
                    list.push(result)
                }
                if (this.peek() !== ',') break
                this.pos++
                if (this.peek() === ']') this.fail()
            }
            this.expect(']')
            return list
        }
        return this.fail()
    }
}

export function parseMIRecord(line: string): MIRecord {
    line = line.replace(/\r$/, '')
    if (/^\(gdb\)\s*$/.test(line)) return { kind: 'prompt' }
    const reader = new Reader(line)
    const tokenText = /^\d+/.exec(line)?.[0]
    if (tokenText) reader.pos = tokenText.length
    const prefix = reader.peek()
    reader.pos++
    const stream = { '~': 'console', '@': 'target', '&': 'log' } as const
    if (prefix in stream) {
        const text = reader.cstring()
        if (reader.pos !== line.length) reader.fail()
        return { kind: stream[prefix as keyof typeof stream], text }
    }
    const kinds = { '^': 'result', '*': 'exec', '+': 'status', '=': 'notify' } as const
    if (!(prefix in kinds)) return { kind: 'output', text: line }
    const cls = reader.word()
    const results: MITuple = {}
    while (reader.peek() === ',') {
        reader.pos++
        reader.result(results)
    }
    if (reader.pos !== line.length) reader.fail()
    return { kind: kinds[prefix as keyof typeof kinds], token: tokenText ? Number(tokenText) : undefined, cls, results }
}

export const miQuote = (text: string): string =>
    '"' +
    text.replace(/[\\"\x00-\x1f\x7f]/g, (char) => {
        const escapes: Record<string, string> = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' }
        return escapes[char] ?? `\\${char.charCodeAt(0).toString(8).padStart(3, '0')}`
    }) +
    '"'
export const miString = (value: MIValue | undefined): string => (typeof value === 'string' ? value : '')
export const miTuple = (value: MIValue | undefined): MITuple =>
    value && typeof value === 'object' && !Array.isArray(value) ? value : {}
export const miList = (value: MIValue | undefined): MIValue[] => (Array.isArray(value) ? value : [])
