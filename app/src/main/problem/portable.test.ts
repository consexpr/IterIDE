import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readIdentity, writeIdentity } from './identity'
import { loadProblem, problemDir, readTests, writeTest } from './store'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))
const command = vi.mocked(execFileSync)
const originalPlatform = process.platform
let temporary: string, source: string
beforeEach(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-portable-'))
    vi.stubEnv('ITER_STORE', path.join(temporary, 'store'))
    source = path.join(temporary, 'source.cpp')
    await fs.writeFile(source, '// source')
    command.mockReset()
})
afterEach(async () => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    vi.unstubAllEnvs()
    if (path.dirname(temporary) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('iter-portable-'))
        throw new Error('Invalid cleanup path')
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5 })
})

describe('optional extended attributes', () => {
    it.each(['darwin', 'linux'] as const)(
        'reads and writes user.iter.id on %s using argument-safe system tools',
        (platform) => {
            Object.defineProperty(process, 'platform', { value: platform })
            command.mockReturnValue('known-id\n')
            expect(readIdentity(source)).toBe('known-id')
            command.mockReturnValue('')
            writeIdentity(source, 'new-id')
            expect(command).toHaveBeenCalledWith(
                platform === 'darwin' ? 'xattr' : 'getfattr',
                platform === 'darwin'
                    ? ['-p', 'user.iter.id', source]
                    : ['--only-values', '-n', 'user.iter.id', '--', source],
                expect.any(Object)
            )
            expect(command).toHaveBeenCalledWith(
                platform === 'darwin' ? 'xattr' : 'setfattr',
                platform === 'darwin'
                    ? ['-w', 'user.iter.id', 'new-id', source]
                    : ['-n', 'user.iter.id', '-v', 'new-id', '--', source],
                expect.any(Object)
            )
        }
    )

    it('keeps loading and saving at the exact path if attributes cannot be written', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux' })
        command.mockImplementation(() => {
            throw Object.assign(new Error('unsupported filesystem'), { code: 'ENOTSUP' })
        })
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            await writeTest(source, { input: 'path binding', answer: '' })
            const dir = problemDir(source)
            expect((await loadProblem(source)).tests).toHaveLength(1)
            expect((await readTests(source, 100))[0].input).toBe('path binding')
            expect(problemDir(source)).toBe(dir)
            expect(warn).not.toHaveBeenCalled()
            expect(await fs.readFile(source, 'utf8')).toBe('// source')
        } finally {
            warn.mockRestore()
        }
    })

    it('does not clone repeatedly if a copied attribute can be read but cannot be rewritten', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux' })
        const attributes = new Map<string, string>()
        let writable = true
        command.mockImplementation((tool, args) => {
            const values = args as string[],
                file = values.at(-1)!
            if (tool === 'getfattr') return attributes.get(file) ?? ''
            if (!writable) throw Object.assign(new Error('read-only attribute'), { code: 'EACCES' })
            attributes.set(file, values[3])
            return ''
        })
        await writeTest(source, { input: 'original', answer: '' })
        const copy = path.join(temporary, 'copy.cpp')
        await fs.copyFile(source, copy)
        attributes.set(copy, attributes.get(source)!)
        writable = false
        const dir = problemDir(copy)
        expect(dir).not.toBe(problemDir(source))
        expect((await readTests(copy, 100))[0].input).toBe('original')
        expect(problemDir(copy)).toBe(dir)
    })
})
