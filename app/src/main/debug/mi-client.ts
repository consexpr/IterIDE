import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import { parseMIRecord, miString, type MIRecord, type MITuple } from './mi'
import { killTree } from './process'
import { toolchainEnv } from '../toolchain'

const MAX_PENDING_COMMANDS = 256
const MAX_MI_LINE = 8 * 1024 * 1024

export class MICommandError extends Error {
    constructor(
        readonly command: string,
        readonly results: MITuple
    ) {
        super(miString(results.msg) || `GDB rejected ${command}`)
    }
}

export class MIClient extends EventEmitter {
    private readonly child: ChildProcessWithoutNullStreams
    private token = 0
    private readonly pending = new Map<
        number,
        { resolve: (value: MITuple) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; command: string }
    >()
    private readonly inferiors = new Map<string, number>()
    private closed = false
    private disposing?: Promise<void>

    constructor(executable: string, cwd: string) {
        super()
        this.child = spawn(executable, ['--interpreter=mi2', '-q', '-nx'], {
            cwd,
            env: toolchainEnv(),
            windowsHide: true,
            detached: process.platform !== 'win32',
            stdio: 'pipe'
        })
        const decoder = new StringDecoder('utf8')
        let buffer = ''
        this.child.stdout.on('data', (data: Buffer) => {
            if (this.closed) return
            buffer += decoder.write(data)
            let newline: number
            while ((newline = buffer.indexOf('\n')) !== -1) {
                if (newline > MAX_MI_LINE) {
                    this.protocolLimit()
                    return
                }
                const line = buffer.slice(0, newline)
                buffer = buffer.slice(newline + 1)
                this.read(line)
            }
            if (buffer.length > MAX_MI_LINE) this.protocolLimit()
        })
        this.child.stderr.on('data', (data: Buffer) =>
            this.emit('record', { kind: 'log', text: data.toString() } satisfies MIRecord)
        )
        this.child.once('error', (error) => this.close(error))
        this.child.once('close', (code, signal) => {
            if (buffer && !this.closed) this.read(buffer + decoder.end())
            this.close(new Error(`GDB exited (${signal ?? code})`))
        })
        this.child.stdin.on('error', (error) => this.close(error))
    }

    private read(line: string): void {
        if (!line) return
        let record: MIRecord
        try {
            record = parseMIRecord(line)
        } catch (error) {
            this.emit('record', { kind: 'log', text: `${String(error)}\n` } satisfies MIRecord)
            return
        }
        if (record.kind === 'notify' && record.cls === 'thread-group-started') {
            const pid = Number(miString(record.results.pid))
            if (Number.isInteger(pid) && pid > 0) this.inferiors.set(miString(record.results.id), pid)
        }
        if (record.kind === 'notify' && record.cls === 'thread-group-exited') {
            this.inferiors.delete(miString(record.results.id))
        }
        if (record.kind === 'result' && record.token !== undefined) {
            const pending = this.pending.get(record.token)
            if (pending) {
                clearTimeout(pending.timer)
                this.pending.delete(record.token)
                if (record.cls === 'error') pending.reject(new MICommandError(pending.command, record.results))
                else pending.resolve(record.results)
            }
        }
        this.emit('record', record)
    }

    command(command: string, timeout = 20_000): Promise<MITuple> {
        if (this.closed) return Promise.reject(new Error('GDB is closed'))
        if (this.pending.size >= MAX_PENDING_COMMANDS) return Promise.reject(new Error('GDB 请求过多，请稍后重试'))
        const queued = this.prepare(command, timeout)
        try {
            this.child.stdin.write(queued.line)
        } catch (error) {
            this.close(error instanceof Error ? error : new Error(String(error)))
        }
        return queued.promise
    }

    /** Pipeline independent setup commands in one write; each keeps its own token. */
    batch(commands: string[]): Promise<MITuple[]> {
        if (this.closed) return Promise.reject(new Error('GDB is closed'))
        if (this.pending.size + commands.length > MAX_PENDING_COMMANDS)
            return Promise.reject(new Error('GDB 请求过多，请稍后重试'))
        const queued = commands.map((command) => this.prepare(command, 20_000))
        try {
            this.child.stdin.write(queued.map((item) => item.line).join(''))
        } catch (error) {
            this.close(error instanceof Error ? error : new Error(String(error)))
        }
        return Promise.all(queued.map((item) => item.promise))
    }

    private prepare(command: string, timeout: number): { line: string; promise: Promise<MITuple> } {
        const token = ++this.token
        const promise = new Promise<MITuple>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(token)
                reject(new Error(`GDB command timed out: ${command}`))
            }, timeout)
            this.pending.set(token, { resolve, reject, timer, command })
        })
        return { line: `${token}${command}\n`, promise }
    }

    get inferiorPids(): number[] {
        return [...this.inferiors.values()]
    }
    interrupt(): void {
        if (!this.closed) this.child.kill('SIGINT')
    }

    private protocolLimit(): void {
        this.close(new Error('GDB 响应超过大小限制'))
        void this.dispose().catch(() => {})
    }

    private close(error: Error): void {
        if (this.closed) return
        this.closed = true
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer)
            pending.reject(error)
        }
        this.pending.clear()
        this.emit('closed', error)
    }

    dispose(): Promise<void> {
        return (this.disposing ??= (async () => {
            // Let GDB close its own child/launcher too. taskkill can be unavailable in
            // restricted Windows environments, but its MI stdin still works.
            if (!this.closed) {
                try {
                    this.child.stdin.write('-gdb-set confirm off\n-gdb-exit\n')
                } catch {
                    /* a concurrent exit already closed stdin */
                }
            }
            this.close(new Error('Debug session stopped'))
            await killTree(this.child, this.inferiorPids)
        })())
    }
}
