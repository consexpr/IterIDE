import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SourceConflictError, writeSourceText } from './sourceFiles'

let root: string, source: string
beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-source-save-'))
    source = path.join(root, 'solution.cpp')
    await fs.writeFile(source, 'original\r\n')
})
afterEach(async () => {
    vi.restoreAllMocks()
    if (
        path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) ||
        !path.basename(root).startsWith('iter-source-save-')
    )
        throw new Error('Invalid source test cleanup path')
    await fs.rm(root, { recursive: true, force: true })
})

it('publishes complete source contents and preserves the Windows problem identity', async () => {
    if (process.platform === 'win32') await fs.writeFile(`${source}:iter.id`, 'problem-123')
    await writeSourceText(source, 'new content\n', 'original\n')
    expect(await fs.readFile(source, 'utf8')).toBe('new content\n')
    if (process.platform === 'win32') expect(await fs.readFile(`${source}:iter.id`, 'utf8')).toBe('problem-123')
    expect(await fs.readdir(root)).toEqual(['solution.cpp'])
})

it('retains the original when replacement fails and removes staging files', async () => {
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('disk failure'), { code: 'EIO' }))
    await expect(writeSourceText(source, 'new content', 'original\n')).rejects.toThrow('disk failure')
    expect(await fs.readFile(source, 'utf8')).toBe('original\r\n')
    expect(await fs.readdir(root)).toEqual(['solution.cpp'])
})

it('keeps the original intact when writing the staged contents fails halfway', async () => {
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
        const handle = await open(...args)
        const write = handle.writeFile.bind(handle)
        vi.spyOn(handle, 'writeFile').mockImplementationOnce(async () => {
            await write('partial')
            throw new Error('disk full')
        })
        return handle
    })
    await expect(writeSourceText(source, 'complete new contents', 'original\n')).rejects.toThrow('disk full')
    expect(await fs.readFile(source, 'utf8')).toBe('original\r\n')
    expect(await fs.readdir(root)).toEqual(['solution.cpp'])
})

it('rejects changes made before saving, during staging, and deletion instead of overwriting them', async () => {
    await expect(writeSourceText(source, 'mine', 'older')).rejects.toBeInstanceOf(SourceConflictError)
    const chmod = fs.chmod.bind(fs)
    vi.spyOn(fs, 'chmod').mockImplementationOnce(async (...args) => {
        await chmod(...args)
        await fs.writeFile(source, 'external edit')
    })
    await expect(writeSourceText(source, 'mine', 'original\n')).rejects.toMatchObject({ actual: 'external edit' })
    expect(await fs.readFile(source, 'utf8')).toBe('external edit')
    await fs.unlink(source)
    await expect(writeSourceText(source, 'mine', 'external edit')).rejects.toMatchObject({ actual: null })
    expect(await fs.readdir(root)).toEqual([])
})

it('serializes competing writes and rejects a stale expected revision', async () => {
    const results = await Promise.allSettled([
        writeSourceText(source, 'first', 'original\n'),
        writeSourceText(source, 'second', 'original\n')
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const saved = await fs.readFile(source, 'utf8')
    expect(['first', 'second']).toContain(saved)
    await writeSourceText(source, 'confirmed replacement', saved)
    expect(await fs.readFile(source, 'utf8')).toBe('confirmed replacement')
})

it('guards a new save destination against unexpected existing contents', async () => {
    await expect(writeSourceText(source, 'mine', null)).rejects.toBeInstanceOf(SourceConflictError)
    const fresh = path.join(root, 'new.cpp')
    await writeSourceText(fresh, 'new', null)
    expect(await fs.readFile(fresh, 'utf8')).toBe('new')
})
