import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { holdCachePath, pruneBuildCache } from './cache-lru'
let directory: string, root: string
beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-lru-test-'))
    root = path.join(directory, 'iter-build')
    await fs.mkdir(root)
})
afterEach(async () => {
    vi.restoreAllMocks()
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('iter-lru-test-'))
        throw Error('Unsafe cleanup')
    await fs.rm(directory, { recursive: true, force: true })
})
async function entry(name: string, lastUsed: number) {
    const dir = path.join(root, 'source', 'flags', name)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'program.exe'), Buffer.alloc(100))
    await fs.writeFile(path.join(dir, 'compile.json'), JSON.stringify({ lastUsed }))
    return dir
}
const exists = (file: string) =>
    fs.access(file).then(
        () => true,
        () => false
    )
it('evicts the least recently used build while protecting reference-counted active entries', async () => {
    const old = await entry('old', 1),
        active = await entry('active', 2),
        recent = await entry('recent', Date.now())
    const release = holdCachePath(path.join(active, 'program.exe')),
        other = holdCachePath(active)
    release()
    release()
    await pruneBuildCache({ root, maxBytes: 150, maxAgeMs: Number.MAX_SAFE_INTEGER })
    expect(await exists(old)).toBe(false)
    expect(await exists(active)).toBe(true)
    expect(await exists(recent)).toBe(false)
    other()
    await pruneBuildCache({ root, maxBytes: 0 })
    expect(await exists(active)).toBe(false)
})
it('expires entries even below the capacity budget and tolerates corrupt manifests', async () => {
    const old = await entry('old', Date.now() - 8 * 86400000),
        recent = await entry('recent', Date.now())
    const corrupt = await entry('corrupt', 1)
    await fs.writeFile(path.join(corrupt, 'compile.json'), '{')
    await fs.utimes(path.join(corrupt, 'compile.json'), new Date(0), new Date(0))
    await pruneBuildCache({ root })
    expect(await exists(old)).toBe(false)
    expect(await exists(corrupt)).toBe(false)
    expect(await exists(recent)).toBe(true)
    await pruneBuildCache({ root })
})
it('never prunes a caller-supplied unrelated directory', async () => {
    await expect(pruneBuildCache({ root: directory, maxBytes: 0 })).rejects.toThrow('unsafe')
    expect(await exists(directory)).toBe(true)
})
it('protects tools as well as source builds', async () => {
    const tool = path.join(root, 'tools', 'testlib')
    await fs.mkdir(tool, { recursive: true })
    await fs.writeFile(path.join(tool, 'testlib.h'), 'header')
    const release = holdCachePath(tool)
    await pruneBuildCache({ root, maxBytes: 0 })
    expect(await exists(tool)).toBe(true)
    release()
    await pruneBuildCache({ root, maxBytes: 0 })
    expect(await exists(tool)).toBe(false)
})
it('removes an eviction candidate from the cache namespace before asynchronous deletion starts', async () => {
    const old = await entry('old', 1)
    const remove = fs.rm.bind(fs)
    let began!: () => void, finish!: () => void
    const deleting = new Promise<void>((resolve) => {
        began = resolve
    })
    const gate = new Promise<void>((resolve) => {
        finish = resolve
    })
    vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
        if (String(target).startsWith(root + path.sep) && options?.recursive) {
            began()
            await gate
        }
        return remove(target, options)
    })
    const pruning = pruneBuildCache({ root, maxBytes: 0 })
    await deleting
    const couldAdoptEvictedFile = await exists(path.join(old, 'program.exe'))
    const fresh = await entry('fresh', Date.now()),
        release = holdCachePath(fresh)
    finish()
    try {
        await pruning
        expect(couldAdoptEvictedFile).toBe(false)
        expect(await exists(fresh)).toBe(true)
    } finally {
        release()
    }
})
