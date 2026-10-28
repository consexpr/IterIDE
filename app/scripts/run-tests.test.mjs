import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { testEnvironment } from './run-tests.mjs'

it('isolates all storage roots per run and does not inherit capture or user profile paths', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'iter-test-launcher-'))
    try {
        const original = {
            ITER_STORE: 'external-store',
            USERPROFILE: 'external-profile',
            TEMP: 'external-temp',
            ITER_CAPTURE: 'capture.png',
            PATH: 'tools'
        }
        const first = await testEnvironment(parent, original)
        const second = await testEnvironment(parent, original)
        expect(first.root).not.toBe(second.root)
        for (const name of [
            'ITER_STORE',
            'ITER_DATA_DIR',
            'TEMP',
            'TMP',
            'TMPDIR',
            'USERPROFILE',
            'HOME',
            'APPDATA',
            'LOCALAPPDATA'
        ]) {
            expect(path.relative(first.root, first.env[name]).startsWith('..')).toBe(false)
            expect(path.isAbsolute(first.env[name])).toBe(true)
        }
        expect(first.env.ITER_CAPTURE).toBeUndefined()
        expect(first.env.PATH).toBe('tools')
        expect(original.ITER_STORE).toBe('external-store')
    } finally {
        await rm(parent, { recursive: true, force: true })
    }
})
