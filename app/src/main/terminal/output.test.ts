import { expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import { pumpTerminalOutput } from './output'
import type { TerminalView } from './host'
import { TERMINAL_MAX_OUTPUT_FRAME_BYTES } from '../../shared/terminal'

function frame(type: string, payload: Buffer): Buffer {
    const result = Buffer.alloc(5 + payload.length)
    result.write(type, 0, 'latin1')
    result.writeUInt32LE(payload.length, 1)
    payload.copy(result, 5)
    return result
}
function fixture() {
    let close!: () => void
    const closed = new Promise<void>((resolve) => {
        close = resolve
    })
    const write = vi.fn(async (_data: Uint8Array) => {})
    const exited = vi.fn()
    const view: TerminalView = { cols: 80, rows: 24, closed, write, exited, close, onInput() {}, onResize() {} }
    return { view, write, exited }
}
it('bounds output while xterm is slow and preserves all bytes and exit ordering', async () => {
    const f = fixture()
    let acknowledge!: () => void
    const waiting = new Promise<void>((resolve) => {
        acknowledge = resolve
    })
    f.write.mockImplementationOnce(() => waiting)
    const payload = Buffer.alloc(16 * 1024, 65)
    const chunks = Array.from({ length: 100 }, () => frame('o', payload))
    const exit = Buffer.alloc(4)
    exit.writeUInt32LE(7)
    chunks.push(frame('x', exit))
    const output = Readable.from(chunks, { objectMode: false, highWaterMark: 32 * 1024 })
    const closingSubscriptions = vi.spyOn(f.view.closed, 'then')
    const pumping = pumpTerminalOutput(output, f.view)
    await vi.waitFor(() => expect(f.write).toHaveBeenCalledTimes(1))
    expect(output.readableLength).toBeLessThanOrEqual(output.readableHighWaterMark + payload.length + 5)
    expect(f.exited).not.toHaveBeenCalled()
    acknowledge()
    await pumping
    expect(f.write).toHaveBeenCalledTimes(100)
    expect(f.write.mock.calls.reduce((bytes, [data]) => bytes + data.byteLength, 0)).toBe(100 * payload.length)
    expect(f.exited).toHaveBeenCalledWith(7)
    expect(closingSubscriptions).toHaveBeenCalledTimes(1)
})
it('closes without waiting for an unacknowledged renderer and drains remaining pipe data', async () => {
    const f = fixture()
    f.write.mockImplementation(() => new Promise<void>(() => {}))
    const output = Readable.from(Array.from({ length: 10 }, () => frame('o', Buffer.alloc(16 * 1024))))
    const pumping = pumpTerminalOutput(output, f.view)
    await vi.waitFor(() => expect(f.write).toHaveBeenCalledTimes(1))
    f.view.close()
    await pumping
    expect(f.write).toHaveBeenCalledTimes(1)
    expect(output.readableEnded).toBe(true)
})
it('accepts fragmented frames and rejects oversized or incomplete frames', async () => {
    const f = fixture()
    const data = frame('o', Buffer.from('中文'))
    await pumpTerminalOutput(Readable.from([data.subarray(0, 3), data.subarray(3, 7), data.subarray(7)]), f.view)
    expect(Buffer.from(f.write.mock.calls[0][0]).toString()).toBe('中文')
    const oversized = Buffer.alloc(5)
    oversized.write('o')
    oversized.writeUInt32LE(TERMINAL_MAX_OUTPUT_FRAME_BYTES + 1, 1)
    await expect(pumpTerminalOutput(Readable.from([oversized]), f.view)).rejects.toThrow('exceeds limit')
    await expect(pumpTerminalOutput(Readable.from([data.subarray(0, 4)]), f.view)).rejects.toThrow('Incomplete')
})
