import { promises as fs } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import type { DebugEvent } from '../../shared/debug'
import { DebugLimitError } from './budget'
type StreamName = 'stdout' | 'stderr' | 'file'
interface State {
    chunks: Buffer[]
    size: number
    decoder: StringDecoder
    text: string
    initialized: boolean
}
type Delta = Extract<DebugEvent, { type: 'output-delta' }>
const names: StreamName[] = ['stdout', 'stderr', 'file']
const BLOCK_BYTES = 64 * 1024
const LIVE_VERIFY_INTERVAL_MS = 1000
const fresh = (): State => ({ chunks: [], size: 0, decoder: new StringDecoder('utf8'), text: '', initialized: false })
/** Exact polls verify every block, including unchanged sizes/timestamps. Live
 * display polls read the tail between periodic full verifications; snapshots
 * and paused output retain their separate exact capture path. */
export class OutputTailer {
    private states = { stdout: fresh(), stderr: fresh(), file: fresh() }
    private work: Promise<unknown> = Promise.resolve()
    private lastVerified?: number
    constructor(
        private readonly files: Partial<Record<StreamName, string>>,
        private readonly outputLimit: number,
        private readonly displayLimit: number
    ) {}
    poll(options: { verify?: boolean } = {}): Promise<Delta> {
        const task = this.work.then(async () => {
            const now = performance.now()
            const verify =
                options.verify !== false ||
                this.lastVerified === undefined ||
                now - this.lastVerified >= LIVE_VERIFY_INTERVAL_MS
            const result = await this.read(verify)
            if (verify) this.lastVerified = now
            return result
        })
        this.work = task.catch(() => {})
        return task
    }
    private async read(verify: boolean): Promise<Delta> {
        const sizes = await Promise.all(
            names.map(async (name) =>
                this.files[name] ? ((await fs.stat(this.files[name]!).catch(() => undefined))?.size ?? 0) : 0
            )
        )
        if (sizes.reduce((sum, size) => sum + size, 0) > this.outputLimit) throw new DebugLimitError('output')
        const changes = new Map<StreamName, { text: string; reset: boolean; changed: boolean }>()
        for (const [streamIndex, name] of names.entries()) {
            const state = this.states[name]
            const full = verify || !state.initialized || sizes[streamIndex] < state.size
            if (!full && sizes[streamIndex] === state.size) {
                changes.set(name, { text: '', reset: false, changed: false })
                continue
            }
            // Re-read only a partial final block during live appends, keeping block
            // boundaries stable so the next exact verification can compare old data.
            const startBlock = full ? 0 : Math.floor(state.size / BLOCK_BYTES)
            const chunks: Buffer[] = state.chunks.slice(0, startBlock),
                added: Buffer[] = []
            let position = startBlock * BLOCK_BYTES,
                reset = !state.initialized
            const file = this.files[name]
                ? await fs.open(this.files[name]!, 'r').catch((error: NodeJS.ErrnoException) => {
                      if (error.code === 'ENOENT') return undefined
                      throw error
                  })
                : undefined
            try {
                if (file) {
                    const buffer = Buffer.allocUnsafe(BLOCK_BYTES)
                    for (;;) {
                        let bytesRead = 0
                        while (bytesRead < buffer.length) {
                            const next = await file.read(
                                buffer,
                                bytesRead,
                                buffer.length - bytesRead,
                                position + bytesRead
                            )
                            if (!next.bytesRead) break
                            bytesRead += next.bytesRead
                        }
                        if (!bytesRead) break
                        if (
                            position +
                                bytesRead +
                                sizes.reduce((sum, size, i) => sum + (names[i] === name ? 0 : size), 0) >
                            this.outputLimit
                        )
                            throw new DebugLimitError('output')
                        const data = buffer.subarray(0, bytesRead),
                            previous = state.chunks[chunks.length]
                        if (
                            previous &&
                            (data.length < previous.length || !data.subarray(0, previous.length).equals(previous))
                        )
                            reset = true
                        // Reuse unchanged buffers and one scratch allocation for the whole
                        // scan; only changed/new blocks need retained copies.
                        const retained = previous?.equals(data) ? previous : Buffer.from(data)
                        chunks.push(retained)
                        if (position + bytesRead > state.size)
                            added.push(retained.subarray(Math.max(0, state.size - position)))
                        position += bytesRead
                    }
                }
            } finally {
                await file?.close()
            }
            if (position < state.size) reset = true
            const changed = reset || position !== state.size
            if (reset) {
                state.decoder = new StringDecoder('utf8')
                state.text = ''
            }
            let delta = ''
            for (const chunk of reset ? chunks : added) {
                const decoded = state.decoder.write(chunk)
                state.text = (state.text + decoded).slice(-this.displayLimit)
                delta = (delta + decoded).slice(-this.displayLimit)
            }
            state.chunks = chunks
            state.size = position
            sizes[streamIndex] = position
            state.initialized = true
            changes.set(name, { text: reset ? state.text : delta, reset, changed })
        }
        const stdout = changes.get('stdout')!,
            stderr = changes.get('stderr')!,
            file = changes.get('file')!
        const resetStdout = stdout.reset || file.reset || (stdout.changed && this.states.file.size > 0)
        const combined = resetStdout
            ? (this.states.stdout.text + this.states.file.text).slice(-this.displayLimit)
            : (stdout.text + file.text).slice(-this.displayLimit)
        return {
            type: 'output-delta',
            stdout: stdout.changed || file.changed ? combined : undefined,
            stderr: stderr.changed ? stderr.text : undefined,
            resetStdout: resetStdout || undefined,
            resetStderr: stderr.reset || undefined,
            stdoutOffset: this.states.stdout.size + this.states.file.size,
            stderrOffset: this.states.stderr.size
        }
    }
}
