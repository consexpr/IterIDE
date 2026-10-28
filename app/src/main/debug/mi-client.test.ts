import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, expect, it, vi } from 'vitest'
const mocked = vi.hoisted(() => ({ spawn: vi.fn(), killTree: vi.fn(async () => {}) }))
vi.mock('node:child_process', () => ({ spawn: mocked.spawn }))
vi.mock('./process', () => ({ killTree: mocked.killTree }))
vi.mock('../toolchain', () => ({ toolchainEnv: () => ({}) }))
import { MIClient } from './mi-client'

let child: EventEmitter & {
    stdout: PassThrough
    stderr: PassThrough
    stdin: PassThrough
    kill: ReturnType<typeof vi.fn>
}
beforeEach(() => {
    vi.clearAllMocks()
    child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        kill: vi.fn()
    })
    mocked.spawn.mockReturnValue(child)
})
it('rejects every pending request on an unexpected GDB exit and closes only once', async () => {
    const client = new MIClient('owned-gdb', '.')
    const closed = vi.fn()
    client.on('closed', closed)
    const requests = Promise.allSettled([client.command('-one'), client.command('-two')])
    child.emit('close', 17, null)
    child.emit('error', new Error('late error'))
    expect(
        (await requests).every((result) => result.status === 'rejected' && String(result.reason).includes('17'))
    ).toBe(true)
    expect(closed).toHaveBeenCalledOnce()
    await expect(client.command('-three')).rejects.toThrow('closed')
    const disposing = client.dispose()
    expect(client.dispose()).toBe(disposing)
    await disposing
    expect(mocked.killTree).toHaveBeenCalledOnce()
})
it('bounds outstanding commands without partially writing an overflowing batch', async () => {
    const client = new MIClient('owned-gdb', '.')
    const requests = Array.from({ length: 255 }, () => client.command('-pending'))
    const settled = Promise.allSettled(requests)
    const size = child.stdin.readableLength
    await expect(client.batch(['-overflow-one', '-overflow-two'])).rejects.toThrow('请求过多')
    expect(child.stdin.readableLength).toBe(size)
    await client.dispose()
    await settled
})
it('turns a synchronous broken stdin into rejected requests', async () => {
    const client = new MIClient('owned-gdb', '.')
    vi.spyOn(child.stdin, 'write').mockImplementation(() => {
        throw new Error('broken stdin')
    })
    await expect(client.command('-query')).rejects.toThrow('broken stdin')
    await client.dispose()
})
it('rejects an oversized unterminated protocol line and terminates its owned process', async () => {
    const client = new MIClient('owned-gdb', '.')
    const request = client.command('-query')
    const failed = expect(request).rejects.toThrow('大小限制')
    child.stdout.write('x'.repeat(8 * 1024 * 1024 + 1))
    await failed
    await client.dispose()
    expect(mocked.killTree).toHaveBeenCalledOnce()
})
