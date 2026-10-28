import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { MODEL_MAX_SOURCE_BYTES } from '../../shared/model'
import type { LexicalToken } from './features'

/** One owned helper, one framed request at a time; no user compiler or source execution. */
export class ClangTokenizer {
    private child?: ChildProcessWithoutNullStreams
    private buffer = Buffer.alloc(0)
    private receive?: {
        resolve: (body: Buffer) => void
        reject: (error: Error) => void
        timer: ReturnType<typeof setTimeout>
    }
    constructor(
        private readonly executable: string,
        private readonly library: string,
        private readonly scratch: string,
        private readonly spawned: (pid: number) => void
    ) {}

    async start(): Promise<void> {
        await mkdir(this.scratch, { recursive: true })
        const hello = this.response(5000)
        this.child = spawn(this.executable, [this.library, path.join(this.scratch, 'lex.cpp'), String(process.pid)], {
            windowsHide: true,
            stdio: 'pipe',
            env: { ...process.env, TEMP: this.scratch, TMP: this.scratch }
        })
        if (this.child.pid) this.spawned(this.child.pid)
        this.child.stdin.on('error', (error) => this.fail(error))
        this.child.stderr.on('data', () => {
            /* Clang diagnostics never enter the completion UI. */
        })
        this.child.stdout.on('data', (chunk) => this.data(chunk))
        this.child.once('error', (error) => this.fail(error))
        this.child.once('exit', () => this.fail(Error('Model tokenizer stopped')))
        const body = await hello
        if (body[0] !== 2 || !/clang version 19\.1\.7(?:\s|$)/.test(body.subarray(1).toString('utf8'))) {
            this.dispose()
            throw Error('Model tokenizer version mismatch')
        }
    }

    private response(timeout: number): Promise<Buffer> {
        if (this.receive) return Promise.reject(Error('Model tokenizer is busy'))
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.fail(Error('Model tokenizer timed out'))
                this.dispose()
            }, timeout)
            this.receive = { resolve, reject, timer }
        })
    }

    private data(chunk: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, chunk])
        if (this.buffer.length > 4 * 1024 * 1024) {
            this.fail(Error('Model tokenizer frame exceeds limit'))
            this.dispose()
            return
        }
        if (this.buffer.length < 4) return
        const length = this.buffer.readUInt32LE(0)
        if (length < 1 || length > 4 * 1024 * 1024) {
            this.fail(Error('Invalid Model tokenizer frame'))
            this.dispose()
            return
        }
        if (this.buffer.length < length + 4) return
        const body = this.buffer.subarray(4, length + 4)
        this.buffer = this.buffer.subarray(length + 4)
        const waiting = this.receive
        if (!waiting) {
            this.dispose()
            return
        }
        this.receive = undefined
        clearTimeout(waiting.timer)
        waiting.resolve(body)
    }

    async tokenize(source: string, standard: string): Promise<LexicalToken[]> {
        if (!this.child || this.child.exitCode !== null) throw Error('Model tokenizer unavailable')
        const code = Buffer.from(source, 'utf8'),
            std = Buffer.from(standard)
        if (code.length > MODEL_MAX_SOURCE_BYTES || code.includes(0)) throw Error('Model source exceeds limits')
        const frame = Buffer.alloc(8 + std.length + code.length)
        frame.writeUInt32LE(frame.length - 4, 0)
        frame.writeUInt32LE(std.length, 4)
        std.copy(frame, 8)
        code.copy(frame, 8 + std.length)
        const received = this.response(800)
        this.child.stdin.write(frame, (error) => {
            if (error) this.fail(error)
        })
        const body = await received
        if (body[0] !== 0 || body.length < 5) throw Error('Model lexical parse failed')
        const count = body.readUInt32LE(1)
        if (body.length !== 5 + count * 9) throw Error('Invalid Model token count')
        const tokens: LexicalToken[] = []
        for (let i = 0; i < count; i++) {
            const offset = 5 + i * 9
            const token = {
                kind: body[offset],
                start: body.readUInt32LE(offset + 1),
                end: body.readUInt32LE(offset + 5)
            }
            if (token.kind > 4 || token.start >= token.end || token.end > code.length)
                throw Error('Invalid Model token range')
            tokens.push(token)
        }
        return tokens
    }

    private fail(error: Error): void {
        const waiting = this.receive
        this.receive = undefined
        if (waiting) {
            clearTimeout(waiting.timer)
            waiting.reject(error)
        }
    }

    dispose(): void {
        this.fail(Error('Model tokenizer disposed'))
        this.child?.stdin.destroy()
        this.child?.kill()
        this.child = undefined
    }
}
