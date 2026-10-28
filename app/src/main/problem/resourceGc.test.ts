import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { collectResources, resourceGraceMs } from './resourceGc'

let directory: string
const kept = '11111111-1111-1111-1111-111111111111'
const orphan = '22222222-2222-2222-2222-222222222222'
const pending = '33333333-3333-3333-3333-333333333333'
const now = Date.now()
beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-resource-gc-'))
    for (const id of [kept, orphan, pending]) {
        const dir = path.join(directory, 'resources', id)
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(path.join(dir, 'data.txt'), 'data')
        const time = id === pending ? now : now - resourceGraceMs - 1000
        await fs.utimes(dir, time / 1000, time / 1000)
    }
})
afterEach(async () => {
    if (
        path.dirname(directory) !== path.resolve(os.tmpdir()) ||
        !path.basename(directory).startsWith('iter-resource-gc-')
    )
        throw new Error('Unexpected cleanup directory')
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5 })
})
it('reclaims only old unreferenced bundles and preserves uncommitted selections', async () => {
    await collectResources(directory, { checker: { path: 'resources/' + kept + '/checker.cpp' } }, false, now)
    expect((await fs.readdir(path.join(directory, 'resources'))).sort()).toEqual([kept, pending])
})
it('recognizes references in quoted absolute compiler flags', async () => {
    await collectResources(
        directory,
        { extraFlags: '-L "C:\\old home\\problems\\id\\resources\\' + orphan + '\\libs"' },
        false,
        now
    )
    expect(await fs.readdir(path.join(directory, 'resources'))).toContain(orphan)
})
it('preserves every bundle while a run owns the problem', async () => {
    await collectResources(directory, {}, true, now)
    expect(await fs.readdir(path.join(directory, 'resources'))).toHaveLength(3)
})
it('preserves import recovery evidence and its bundles', async () => {
    await fs.mkdir(path.join(directory, '.import-' + orphan))
    await collectResources(directory, {}, false, now)
    expect(await fs.readdir(path.join(directory, 'resources'))).toHaveLength(3)
})
it('reclaims an interrupted unpublished bundle after the grace period', async () => {
    const stage = path.join(directory, '.resources-' + orphan)
    await fs.mkdir(stage)
    await fs.utimes(stage, (now - resourceGraceMs - 1000) / 1000, (now - resourceGraceMs - 1000) / 1000)
    await collectResources(directory, {}, false, now)
    expect(await fs.readdir(directory)).not.toContain(path.basename(stage))
})
