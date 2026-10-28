import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NtExecutable, NtExecutableResource } from 'pe-library'
import { describe, expect, it } from 'vitest'
import { addGdbUtf8Manifest, ensureGdbUtf8, GDB_UTF8, UTF8_MANIFEST } from './gdb-utf8.mjs'

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const fixture = await readFile(
    process.env.ITER_TEST_ORIGINAL_GDB ?? fileURLToPath(new URL('../resources/toolchain/bin/gdb.exe', import.meta.url))
).catch(() => undefined)
const upstream = fixture && digest(fixture) === GDB_UTF8.upstreamSha256
const supported = fixture && [GDB_UTF8.upstreamSha256, GDB_UTF8.patchedSha256].includes(digest(fixture))

describe('pinned bundled GDB UTF-8 manifest', () => {
    it('refuses unknown executable bytes without modifying its input', () => {
        const bytes = Buffer.from('an unverified executable'),
            original = Buffer.from(bytes)
        expect(() => addGdbUtf8Manifest(bytes)).toThrow(/Unknown bundled GDB SHA-256/)
        expect(bytes).toEqual(original)
    })

    it.skipIf(!upstream)(
        'preserves code, extra data and every original resource in a reproducible unsigned image',
        () => {
            const before = NtExecutable.from(fixture),
                afterBytes = addGdbUtf8Manifest(fixture).bytes
            const after = NtExecutable.from(afterBytes)
            const sections = (image) =>
                image
                    .getAllSections()
                    .filter((section) => section.info.name !== '.rsrc')
                    .map((section) => [section.info.name, digest(Buffer.from(section.data ?? new ArrayBuffer(0)))])
            const resources = (image) =>
                NtExecutableResource.from(image)
                    .entries.filter((entry) => entry.type !== 24)
                    .map((entry) => [entry.type, entry.id, entry.lang, entry.codepage, digest(Buffer.from(entry.bin))])
            expect(sections(after)).toEqual(sections(before))
            expect(digest(Buffer.from(after.getExtraData() ?? new ArrayBuffer(0)))).toBe(
                digest(Buffer.from(before.getExtraData() ?? new ArrayBuffer(0)))
            )
            expect(resources(after)).toEqual(resources(before))
            const manifests = NtExecutableResource.from(after).entries.filter((entry) => entry.type === 24)
            expect(manifests).toHaveLength(1)
            expect(manifests[0]).toMatchObject({ id: 1, lang: 1033, codepage: 65001 })
            expect(Buffer.from(manifests[0].bin).toString('utf8')).toBe(UTF8_MANIFEST)
            expect(digest(afterBytes)).toBe(GDB_UTF8.patchedSha256)
            const repeated = addGdbUtf8Manifest(afterBytes)
            expect(repeated.applied).toBe(false)
            expect(repeated.bytes).toBe(afterBytes)
            const tampered = Buffer.from(afterBytes)
            tampered[tampered.length - 1] ^= 1
            expect(() => addGdbUtf8Manifest(tampered)).toThrow(/Unknown bundled GDB SHA-256/)
        }
    )

    it.skipIf(!supported)('patches a copied file once and leaves unknown files intact', async () => {
        const parent = path.resolve(os.tmpdir()),
            temp = await mkdtemp(path.join(parent, 'iter-gdb-manifest-'))
        try {
            const bin = path.join(temp, 'bin'),
                file = path.join(bin, 'gdb.exe')
            await mkdir(bin)
            await writeFile(file, fixture)
            expect(await ensureGdbUtf8(temp)).toMatchObject({ ...GDB_UTF8, applied: !!upstream })
            expect(digest(await readFile(file))).toBe(GDB_UTF8.patchedSha256)
            expect(await ensureGdbUtf8(temp)).toMatchObject({ ...GDB_UTF8, applied: false })
            expect(await readdir(bin)).toEqual(['gdb.exe'])
            const unknown = Buffer.from('unknown manifest or release')
            await writeFile(file, unknown)
            await expect(ensureGdbUtf8(temp)).rejects.toThrow(/Unknown bundled GDB SHA-256/)
            expect(await readFile(file)).toEqual(unknown)
            expect(await readdir(bin)).toEqual(['gdb.exe'])
        } finally {
            const target = path.resolve(temp)
            if (path.dirname(target) !== parent || !path.basename(target).startsWith('iter-gdb-manifest-'))
                throw new Error('Unsafe manifest test cleanup path')
            await rm(target, { recursive: true, force: true })
        }
    })
})
