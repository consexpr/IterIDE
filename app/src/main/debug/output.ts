import { StringDecoder } from 'node:string_decoder'
import type { Snapshot } from './trace'
interface Chunk {
    previous?: Chunk
    data: Buffer
    length: number
}
interface Output {
    stdout?: Chunk
    stderr?: Chunk
    file?: Chunk
}
const bytes = (chunk?: Chunk): Buffer => {
    const parts: Buffer[] = []
    for (let item = chunk; item; item = item.previous) parts.push(item.data)
    return Buffer.concat(parts.reverse())
}
const text = (buffer: Buffer): string => new StringDecoder('utf8').write(buffer)
const tailText = (chunk: Chunk | undefined, limit: number): string => {
    if (!Number.isFinite(limit)) return text(bytes(chunk))
    const parts: Buffer[] = []
    let left = Math.max(0, limit) * 4 + 3
    for (let item = chunk; item && left > 0; item = item.previous) {
        const part = item.data.subarray(Math.max(0, item.data.length - left))
        parts.push(part)
        left -= part.length
    }
    const buffer = Buffer.concat(parts.reverse())
    let start = 0
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++
    return text(buffer.subarray(start)).slice(-limit)
}
/** Persistent output chunks keep rewinds exact, including freopen/fseek writes,
 * without retaining a full copy of the output at every recorded stop. */
export class TraceOutput {
    private states: Output[] = []
    add(snapshot: Snapshot): void {
        const state = { ...this.states.at(-1) }
        for (const stream of ['stdout', 'stderr', 'file'] as const) {
            const change = snapshot.outputChanges?.[stream]
            if (change) {
                const data = Buffer.from(change.data, 'base64'),
                    previous = change.reset ? undefined : state[stream]
                state[stream] = { data, previous, length: data.length + (previous?.length ?? 0) }
            }
        }
        this.states.push(state)
    }
    buffers(index: number): { stdout: Buffer; stderr: Buffer; file: Buffer } {
        const state = this.states[index]
        return { stdout: bytes(state?.stdout), stderr: bytes(state?.stderr), file: bytes(state?.file) }
    }
    view(
        index: number,
        displayLimit = Infinity
    ): { stdout: string; stderr: string; stdoutOffset: number; stderrOffset: number } {
        const state = this.states[index]
        const stdout = tailText(state?.stdout, displayLimit) + tailText(state?.file, displayLimit)
        return {
            stdout: Number.isFinite(displayLimit) ? stdout.slice(-displayLimit) : stdout,
            stderr: tailText(state?.stderr, displayLimit),
            stdoutOffset: (state?.stdout?.length ?? 0) + (state?.file?.length ?? 0),
            stderrOffset: state?.stderr?.length ?? 0
        }
    }
}
