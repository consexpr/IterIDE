import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createSnapshot, deleteSnapshot, listSnapshots, readSnapshot, renameSnapshot } from './snapshots'
import { moveSource, problemDir } from './problem/store'
import { createUntitled, discardUntitled } from './untitled'

let root: string, source: string, other: string
beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-snapshots-'))
    vi.stubEnv('ITER_STORE', path.join(root, 'store'))
    source = path.join(root, 'one', 'main.cpp')
    other = path.join(root, 'two', 'main.cpp')
    for (const file of [source, other]) {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, '// disk source')
    }
})
afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('iter-snapshots-'))
        throw new Error('Unexpected cleanup path')
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 })
})

it('keeps same-named programs separate and persists unsaved Unicode and empty code', async () => {
    const a = await createSnapshot(source, '// 未保存\nint main() {}')
    const b = await createSnapshot(other, '')
    expect(await listSnapshots(source)).toEqual([a])
    expect(await listSnapshots(other)).toEqual([b])
    expect((await readSnapshot(source, a.id)).code).toBe('// 未保存\nint main() {}')
    expect((await readSnapshot(other, b.id)).code).toBe('')
    expect(await fs.readFile(source, 'utf8')).toBe('// disk source')
    await expect(readSnapshot(other, a.id)).rejects.toThrow('没有该快照')
    await expect(deleteSnapshot(other, a.id)).rejects.toThrow('没有该快照')
    await expect(readSnapshot(source, '../index')).rejects.toThrow('没有该快照')
})

it('serializes rapid saves and supports rename/delete without affecting other versions', async () => {
    const entries = await Promise.all(['a', 'b', 'c'].map((code) => createSnapshot(source, code)))
    expect(await listSnapshots(source)).toHaveLength(3)
    await renameSnapshot(source, entries[1].id, ' 修改前 ')
    expect((await readSnapshot(source, entries[1].id)).name).toBe('修改前')
    await deleteSnapshot(source, entries[0].id)
    expect((await listSnapshots(source)).map((e) => e.id)).toEqual([entries[2].id, entries[1].id])
    await renameSnapshot(source, entries[1].id, '  ')
    expect((await readSnapshot(source, entries[1].id)).name).toBe('')
})

it('keeps untitled snapshots after first save, without merging the destination history', async () => {
    const untitled = await createUntitled(1, '// new')
    const checkpoint = await createSnapshot(untitled, '// draft')
    await createSnapshot(source, '// previous program')
    await moveSource(untitled, source)
    await discardUntitled(untitled)
    expect(await listSnapshots(source)).toEqual([checkpoint])
    expect((await readSnapshot(source, checkpoint.id)).code).toBe('// draft')
})

it('preserves the previous index if publishing a new entry fails', async () => {
    const first = await createSnapshot(source, 'first')
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (String(to).endsWith(path.join('snapshots', 'index.json')))
            throw Object.assign(new Error('index write failed'), { code: 'EIO' })
        return rename(from, to)
    })
    await expect(createSnapshot(source, 'second')).rejects.toThrow('index write failed')
    expect(await listSnapshots(source)).toEqual([first])
    expect((await fs.readdir(path.join(problemDir(source), 'snapshots'))).sort()).toEqual(
        [`${first.id}.cpp`, 'index.json'].sort()
    )
})

it('does not overwrite a damaged index', async () => {
    const entry = await createSnapshot(source, 'recoverable')
    const index = path.join(problemDir(source), 'snapshots', 'index.json')
    await fs.writeFile(index, '{broken')
    await expect(createSnapshot(source, 'new')).rejects.toThrow()
    expect(await fs.readFile(index, 'utf8')).toBe('{broken')
    expect(await fs.readFile(path.join(path.dirname(index), `${entry.id}.cpp`), 'utf8')).toBe('recoverable')
})
