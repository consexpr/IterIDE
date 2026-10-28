import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadProblem, readTests, writeTest } from './problem/store'
import { loadSession, sanitizeSession, saveSession } from './session'
import { createUntitled, discardUntitled, isUntitledPath, sweepUntitled, untitledPath } from './untitled'

let temporary: string
beforeEach(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-untitled-'))
    vi.stubEnv('ITER_STORE', path.join(temporary, 'store'))
})
afterEach(async () => {
    vi.unstubAllEnvs()
    if (path.dirname(temporary) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('iter-untitled-'))
        throw new Error('Invalid cleanup path')
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5 })
})
const stored = async (): Promise<string[]> =>
    fs.readdir(path.join(temporary, 'store', 'problems')).catch(() => [] as string[])

describe('untitled files', () => {
    it('lives in the app folder as a real file and is recognised by name and place only', async () => {
        const file = await createUntitled(2, 'int main() {}\n')
        expect(file).toBe(untitledPath(2))
        expect(await fs.readFile(file, 'utf8')).toBe('int main() {}\n')
        expect(isUntitledPath(file)).toBe(true)
        expect(isUntitledPath(path.join(temporary, 'Untitled-2.cpp'))).toBe(false)
        expect(isUntitledPath(path.join(path.dirname(file), 'solution.cpp'))).toBe(false)
        expect(() => untitledPath(0)).toThrow()
    })

    it('a fresh slot forgets the tests of whatever used the number before', async () => {
        const file = await createUntitled(1, 'a')
        await writeTest(file, { id: '1', input: 'old', answer: '' })
        await createUntitled(1, 'b')
        expect(await readTests(file, 100)).toEqual([])
        expect(await fs.readFile(file, 'utf8')).toBe('b')
    })

    it('discarding removes the file together with its stored problem, and refuses other files', async () => {
        const file = await createUntitled(3, 'x')
        await loadProblem(file)
        expect(await stored()).toHaveLength(1)
        await discardUntitled(file)
        expect(await stored()).toEqual([])
        await expect(fs.access(file)).rejects.toThrow()
        const other = path.join(temporary, 'keep.cpp')
        await fs.writeFile(other, 'keep')
        await expect(discardUntitled(other)).rejects.toThrow()
        expect(await fs.readFile(other, 'utf8')).toBe('keep')
    })

    it('sweeping keeps the listed files and clears the rest', async () => {
        const keep = await createUntitled(1, 'k'),
            drop = await createUntitled(2, 'd')
        await loadProblem(drop)
        await sweepUntitled([keep])
        expect(await fs.readFile(keep, 'utf8')).toBe('k')
        await expect(fs.access(drop)).rejects.toThrow()
        expect(await stored()).toEqual([])
    })
})

describe('session file', () => {
    it('round-trips tabs with their unsaved buffers', async () => {
        const untitled = untitledPath(1)
        await saveSession(temporary, {
            version: 1,
            active: untitled,
            tabs: [
                { path: untitled, untitled: 1, text: 'new code', saved: '' },
                { path: path.join(temporary, 'a.cpp'), text: 'edited', saved: 'original' }
            ]
        })
        expect(await loadSession(temporary)).toEqual({
            version: 1,
            active: untitled,
            tabs: [
                { path: untitled, untitled: 1, text: 'new code', saved: '' },
                { path: path.join(temporary, 'a.cpp'), text: 'edited', saved: 'original' }
            ]
        })
    })

    it('drops malformed, duplicated and spoofed tabs instead of failing', () => {
        const real = untitledPath(1)
        const result = sanitizeSession({
            active: 'gone.cpp',
            tabs: [
                null,
                { path: 'a.cpp', text: 1, saved: '' },
                { path: 'a.cpp', text: 'x', saved: 'x' },
                { path: 'a.cpp', text: 'dup', saved: 'dup' },
                { path: path.join(temporary, 'elsewhere.cpp'), untitled: 1, text: 't', saved: '' },
                { path: real, text: 'no marker', saved: '' },
                { path: real, untitled: 1, text: 'ok', saved: '' }
            ]
        })
        expect(result).toEqual({
            version: 1,
            active: null,
            tabs: [
                { path: 'a.cpp', text: 'x', saved: 'x' },
                { path: real, untitled: 1, text: 'ok', saved: '' }
            ]
        })
        expect(sanitizeSession('nope')).toBeNull()
        expect(sanitizeSession({ tabs: 'x' })).toBeNull()
    })

    it('returns no session for a missing file but reports damaged data without replacing it', async () => {
        expect(await loadSession(temporary)).toBeNull()
        await fs.writeFile(path.join(temporary, 'session.json'), '{broken')
        await expect(loadSession(temporary)).rejects.toThrow('会话文件无法读取')
        expect(await fs.readFile(path.join(temporary, 'session.json'), 'utf8')).toBe('{broken')
    })
})
