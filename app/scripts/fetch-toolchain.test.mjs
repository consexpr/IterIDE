import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { readToolchainMarker, writeToolchainMarker } from './fetch-toolchain.mjs'

it('recovers a missing or invalid marker, atomically replaces it and skips identical metadata', async () => {
    const parent = path.resolve(os.tmpdir()),
        directory = await mkdtemp(path.join(parent, 'iter-toolchain-marker-'))
    try {
        const file = path.join(directory, 'iter-toolchain.json')
        expect(await readToolchainMarker(file)).toBeNull()
        await writeFile(file, '{truncated')
        expect(await readToolchainMarker(file)).toBeNull()
        const marker = {
            sha256: 'upstream-archive',
            gdbCompatibility: { version: 1, upstreamSha256: 'original', patchedSha256: 'derived' }
        }
        expect(await writeToolchainMarker(file, marker)).toBe(true)
        expect(await readToolchainMarker(file)).toEqual(marker)
        const text = await readFile(file, 'utf8')
        expect(await writeToolchainMarker(file, marker)).toBe(false)
        expect(await readFile(file, 'utf8')).toBe(text)
        expect(await readdir(directory)).toEqual(['iter-toolchain.json'])
    } finally {
        const target = path.resolve(directory)
        if (path.dirname(target) !== parent || !path.basename(target).startsWith('iter-toolchain-marker-'))
            throw new Error('Unsafe marker test cleanup path')
        await rm(target, { recursive: true, force: true })
    }
})
