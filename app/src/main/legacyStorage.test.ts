import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LEGACY_BRAND } from '../shared/legacyBrand'
import { defaultProblem } from '../shared/problem'
import {
    LEGACY_PROFILE_NAME,
    LEGACY_STORE_NAME,
    migrateLegacyStorage,
    relocatedLegacyPath,
    resetLegacyStorage
} from './legacyStorage'
import { normalize } from './problem/config'
import { readIndex, readMeta } from './problem/identity'
import { loadSession } from './session'

let root: string
const write = (file: string, value: string): void => {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, value)
}
const options = () => ({
    appData: path.join(root, 'profile'),
    home: path.join(root, 'home'),
    userData: path.join(root, 'profile', 'ITER'),
    store: path.join(root, 'home', '.iter'),
    migrateStore: true
})
beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'iter-brand-storage-'))
    resetLegacyStorage()
    vi.stubEnv('ITER_STORE', options().store)
})
afterEach(() => {
    resetLegacyStorage()
    vi.unstubAllEnvs()
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('iter-brand-storage-'))
        throw new Error('Invalid test cleanup path')
    rmSync(root, { recursive: true, force: true })
})

it('copies legacy data once, preserving unsaved sessions and problem identities without changing journal bytes', async () => {
    const target = options(),
        oldStore = path.join(target.home, LEGACY_STORE_NAME)
    const oldProfile = path.join(target.appData, LEGACY_PROFILE_NAME)
    const oldSource = path.join(oldStore, 'untitled', 'Untitled-1.cpp')
    const oldProblem = path.join(oldStore, 'problems', 'example')
    const config = JSON.stringify({
        ...defaultProblem('example'),
        checker: { kind: 'custom', path: path.join(oldProblem, 'checker.cpp') }
    })
    const metadata = JSON.stringify({
        id: 'example',
        sourcePath: oldSource,
        title: 'example',
        createdAt: 1,
        updatedAt: 1
    })
    write(oldSource, '// saved')
    write(path.join(oldStore, 'index.json'), JSON.stringify({ example: oldSource }))
    write(path.join(oldProblem, 'meta.json'), metadata)
    write(path.join(oldProblem, 'problem.json'), config)
    write(path.join(oldProblem, '.import-pending', 'journal.json'), '{"after":"unchanged bytes"}')
    write(
        path.join(oldProfile, 'session.json'),
        JSON.stringify({
            version: 1,
            active: oldSource,
            tabs: [{ path: oldSource, untitled: 1, text: '// unsaved edit', saved: '// saved' }]
        })
    )
    write(path.join(oldProfile, 'Partitions', `${LEGACY_BRAND}-plugin-example`, 'Cookies'), 'plugin session')
    write(path.join(oldProfile, 'Cache', 'discardable'), 'cache')
    migrateLegacyStorage(target)
    const newSource = path.join(target.store, 'untitled', 'Untitled-1.cpp')
    expect(readIndex()).toEqual({ example: newSource })
    const newProblem = path.join(target.store, 'problems', 'example')
    expect(readMeta(newProblem)?.sourcePath).toBe(newSource)
    expect(normalize(newSource, JSON.parse(config)).checker.path).toBe(path.join(newProblem, 'checker.cpp'))
    expect(await loadSession(target.userData)).toMatchObject({
        active: newSource,
        tabs: [{ path: newSource, untitled: 1, text: '// unsaved edit' }]
    })
    expect(readFileSync(path.join(newProblem, 'problem.json'), 'utf8')).toBe(config)
    expect(readFileSync(path.join(newProblem, '.import-pending', 'journal.json'), 'utf8')).toBe(
        '{"after":"unchanged bytes"}'
    )
    expect(readFileSync(path.join(oldProblem, 'meta.json'), 'utf8')).toBe(metadata)
    expect(readFileSync(path.join(target.userData, 'Partitions', 'iter-plugin-example', 'Cookies'), 'utf8')).toBe(
        'plugin session'
    )
    expect(existsSync(path.join(target.userData, 'Cache'))).toBe(false)
    write(
        path.join(target.store, 'index.json'),
        JSON.stringify({ example: newSource, another: path.join(root, 'another.cpp') })
    )
    resetLegacyStorage()
    migrateLegacyStorage(target)
    expect(readIndex().another).toBe(path.join(root, 'another.cpp'))
    expect(relocatedLegacyPath(oldSource)).toBe(newSource)
    expect(relocatedLegacyPath(path.join(target.home, `${LEGACY_STORE_NAME}-other`, 'file.cpp'))).toBe(
        path.join(target.home, `${LEGACY_STORE_NAME}-other`, 'file.cpp')
    )
})

it('does not overwrite existing ITER directories or migrate an explicitly configured store', () => {
    const target = options()
    const oldStore = path.join(target.home, LEGACY_STORE_NAME)
    const oldProfile = path.join(target.appData, LEGACY_PROFILE_NAME)
    write(path.join(oldStore, 'index.json'), '{"legacy":true}')
    write(path.join(oldProfile, 'settings.json'), '{"legacy":true}')
    write(path.join(target.store, 'index.json'), '{"current":true}')
    write(path.join(target.userData, 'settings.json'), '{"current":true}')
    migrateLegacyStorage(target)
    expect(readFileSync(path.join(target.store, 'index.json'), 'utf8')).toBe('{"current":true}')
    expect(readFileSync(path.join(target.userData, 'settings.json'), 'utf8')).toBe('{"current":true}')
    expect(relocatedLegacyPath(path.join(oldStore, 'file.cpp'))).toBe(path.join(oldStore, 'file.cpp'))
    const explicit = path.join(root, 'explicit-store')
    migrateLegacyStorage({ ...target, store: explicit, migrateStore: false })
    expect(existsSync(explicit)).toBe(false)
})

it('leaves old directories intact and publishes no partial profile if plugin partition names collide', () => {
    const target = options(),
        profile = path.join(target.appData, LEGACY_PROFILE_NAME)
    write(path.join(profile, 'Partitions', `${LEGACY_BRAND}-plugin-example`, 'Cookies'), 'legacy')
    write(path.join(profile, 'Partitions', 'iter-plugin-example', 'Cookies'), 'current')
    expect(() => migrateLegacyStorage(target)).toThrow('原目录保持不变')
    expect(existsSync(target.userData)).toBe(false)
    expect(readFileSync(path.join(profile, 'Partitions', `${LEGACY_BRAND}-plugin-example`, 'Cookies'), 'utf8')).toBe(
        'legacy'
    )
})
