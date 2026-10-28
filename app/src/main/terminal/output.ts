import type { Readable } from 'node:stream'
import { TERMINAL_MAX_OUTPUT_FRAME_BYTES } from '../../shared/terminal'
import type { TerminalView } from './host'

/** Await xterm's acknowledgement before taking more output from the helper.
 * The Readable's high-water mark bounds the remaining pipe data, so a slow
 * renderer applies pressure all the way back to the contestant's console. */
export async function pumpTerminalOutput(output: Readable, view: TerminalView): Promise<void> {
    let pending = Buffer.alloc(0),
        closed = false
    let cancelWrite: (() => void) | undefined
    // Subscribe once. Racing every chunk against the same unresolved closed
    // promise would retain one promise reaction per chunk until the window closes.
    void view.closed.then(() => {
        closed = true
        cancelWrite?.()
    })
    for await (const chunk of output) {
        // Keep draining after close: the helper's close event also waits on stdio.
        if (closed) continue
        pending = Buffer.concat([pending, chunk as Buffer])
        while (pending.length >= 5) {
            const length = pending.readUInt32LE(1)
            if (length > TERMINAL_MAX_OUTPUT_FRAME_BYTES) throw new Error('Terminal output frame exceeds limit')
            if (pending.length < 5 + length) break
            const type = String.fromCharCode(pending[0]),
                payload = pending.subarray(5, 5 + length)
            pending = pending.subarray(5 + length)
            if (type === 'o') {
                // Closing or cancelling cannot wait for a stalled/crashed renderer ACK.
                const cancelled = new Promise<void>((resolve) => {
                    cancelWrite = resolve
                })
                try {
                    await Promise.race([view.write(new Uint8Array(payload)), cancelled])
                } finally {
                    cancelWrite = undefined
                }
                if (closed) break
            } else if (type === 'x' && length === 4) view.exited(payload.readUInt32LE(0))
            else throw new Error('Invalid terminal output frame')
        }
    }
    if (!closed && pending.length) throw new Error('Incomplete terminal output frame')
}
