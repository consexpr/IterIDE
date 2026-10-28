import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { OutputTailer } from './output-tailer'
import { DebugLimitError, TraceBudget } from './budget'
let dir: string, file: string
beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-output-delta-'))
    file = path.join(dir, 'stdout')
})
afterEach(async () => {
    vi.restoreAllMocks()
    if (dir) await fs.rm(dir, { recursive: true, force: true })
})
it('reads only appended blocks between full live verifications', async () => {
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const initialBytes = 2 * 64 * 1024
    await fs.writeFile(file, Buffer.alloc(initialBytes, 65))
    const tail = new OutputTailer({ stdout: file }, initialBytes + 100, 100)
    await tail.poll()
    const positions: number[] = []
    const originalOpen = fs.open.bind(fs)
    const opening = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await originalOpen(...args)
        const read = handle.read.bind(handle)
        handle.read = ((...readArgs: unknown[]) => {
            positions.push(Number(readArgs[3]))
            return Reflect.apply(read, undefined, readArgs)
        }) as typeof handle.read
        return handle
    })
    now += 100
    expect((await tail.poll({ verify: false })).stdout).toBeUndefined()
    expect(opening).not.toHaveBeenCalled()
    await fs.appendFile(file, '中')
    expect(await tail.poll({ verify: false })).toMatchObject({ stdout: '中', stdoutOffset: initialBytes + 3 })
    expect(positions[0]).toBe(initialBytes)
    expect(positions).not.toContain(0)
})
it('eventually verifies prefix overwrites even with unchanged size and timestamps', async () => {
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    await fs.writeFile(file, 'abc-tail')
    const original = await fs.stat(file)
    const tail = new OutputTailer({ stdout: file }, 100, 100)
    await tail.poll({ verify: false })
    await fs.writeFile(file, 'xyz-tail')
    await fs.utimes(file, original.atime, original.mtime)
    now += 100
    expect((await tail.poll({ verify: false })).stdout).toBeUndefined()
    now += 1000
    expect(await tail.poll({ verify: false })).toMatchObject({ resetStdout: true, stdout: 'xyz-tail' })
    await fs.writeFile(file, '123-tail')
    // An explicit exact poll never waits for the live verification interval.
    expect(await tail.poll()).toMatchObject({ resetStdout: true, stdout: '123-tail' })
})
it('detects append, prefix overwrite with append, truncate and incomplete UTF-8', async () => {
    const tail = new OutputTailer({ stdout: file }, 1000, 1000)
    await fs.writeFile(file, Buffer.from([0xe4, 0xb8]))
    expect(await tail.poll()).toMatchObject({ resetStdout: true, stdout: '', stdoutOffset: 2 })
    await fs.appendFile(file, Buffer.from([0xad]))
    expect(await tail.poll()).toMatchObject({ stdout: '中', stdoutOffset: 3 })
    await fs.writeFile(file, 'ab-more')
    expect(await tail.poll()).toMatchObject({ resetStdout: true, stdout: 'ab-more', stdoutOffset: 7 })
    await fs.writeFile(file, 'ab')
    expect(await tail.poll()).toMatchObject({ resetStdout: true, stdout: 'ab', stdoutOffset: 2 })
    await fs.writeFile(file, 'xb-tail')
    expect(await tail.poll()).toMatchObject({ resetStdout: true, stdout: 'xb-tail', stdoutOffset: 7 })
})
it('bounds aggregate file output and display independently and serializes polls', async () => {
    const tail = new OutputTailer({ stdout: file }, 10, 3)
    await fs.writeFile(file, '12345')
    const [first, second] = await Promise.all([tail.poll(), tail.poll()])
    expect(first.stdout).toBe('345')
    expect(second.stdout).toBeUndefined()
    await fs.writeFile(file, '01234567890')
    await expect(tail.poll()).rejects.toBeInstanceOf(DebugLimitError)
})
it('shares trace byte/node budgets across subsequent snapshots', () => {
    const bytes = new TraceBudget(10, 100)
    bytes.accept(6, 1)
    expect(() => bytes.accept(5, 1)).toThrow('trace')
    const nodes = new TraceBudget(100, 3)
    nodes.accept(1, 2)
    expect(() => nodes.accept(1, 2)).toThrow('nodes')
})
