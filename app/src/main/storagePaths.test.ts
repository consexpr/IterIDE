import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { App } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStoragePaths, resolveStoragePaths } from './storagePaths'

vi.mock('node:fs', () => ({ mkdirSync: vi.fn(), openSync: vi.fn(() => 1), closeSync: vi.fn(), unlinkSync: vi.fn() }))

beforeEach(() => {
    vi.clearAllMocks()
    for (const key of ['ITER_DATA_DIR', 'ITER_STORE', 'TEMP', 'TMP', 'TMPDIR']) vi.stubEnv(key, undefined)
})
afterEach(() => vi.unstubAllEnvs())

const windows = {
    platform: 'win32' as const,
    packaged: true,
    application: 'D:\\ITER\\resources\\app.asar',
    appData: 'C:\\Users\\User\\AppData\\Roaming',
    home: 'C:\\Users\\User',
    env: {}
}

describe('Windows release storage paths', () => {
    it('uses ITER paths for the published profile and problem store', () => {
        const paths = resolveStoragePaths(windows)
        expect(paths.userData).toBe('C:\\Users\\User\\AppData\\Roaming\\ITER')
        expect(paths.store).toBe('C:\\Users\\User\\.iter')
        expect(paths.root).toBe(paths.userData)
        expect(paths.temp).toBe(path.win32.join(paths.userData, 'temp'))
        // Chromium must keep opening the existing Local Storage directory after upgrade.
        expect(paths.sessionData).toBe(paths.userData)
        expect(path.win32.join(paths.sessionData, 'Local Storage')).toBe(
            'C:\\Users\\User\\AppData\\Roaming\\ITER\\Local Storage'
        )
    })
    it('isolates all data when ITER_DATA_DIR is explicitly specified on any drive', () => {
        for (const root of ['C:\\IterData', 'E:\\IterData', 'F:\\Custom Data']) {
            const paths = resolveStoragePaths({ ...windows, env: { ITER_DATA_DIR: root } })
            for (const directory of Object.values(paths))
                expect(directory === root || directory.startsWith(root + '\\')).toBe(true)
            expect(paths.userData).toBe(path.win32.join(root, 'userData'))
            expect(paths.sessionData).toBe(path.win32.join(root, 'sessionData'))
            expect(paths.store).toBe(path.win32.join(root, 'store'))
        }
    })
    it('always respects ITER_STORE over the default or isolated problem store', () => {
        expect(resolveStoragePaths({ ...windows, env: { ITER_STORE: 'E:\\Problems' } })).toMatchObject({
            userData: path.win32.join(windows.appData, 'ITER'),
            store: 'E:\\Problems'
        })
        expect(
            resolveStoragePaths({ ...windows, env: { ITER_DATA_DIR: 'F:\\Data', ITER_STORE: 'C:\\Problems' } })
        ).toMatchObject({ root: 'F:\\Data', store: 'C:\\Problems' })
    })
    it('rejects relative overrides rather than resolving them against the current working directory', () => {
        for (const env of [{ ITER_STORE: '.\\store' }, { ITER_DATA_DIR: '.\\data' }]) {
            expect(() => resolveStoragePaths({ ...windows, env })).toThrow()
        }
    })
    it('isolates development data beneath the project sandbox', () => {
        expect(
            resolveStoragePaths({ ...windows, packaged: false, application: 'D:\\VibeProject\\ITER\\app' }).root
        ).toBe('D:\\VibeProject\\ITER\\sandbox\\runtime')
    })

    it('does not resolve system appData when an explicit isolated directory is supplied', () => {
        vi.stubEnv('ITER_DATA_DIR', 'E:\\Isolated')
        const app = {
            isPackaged: true,
            getAppPath: vi.fn(() => {
                throw new Error('unavailable app path')
            }),
            getPath: vi.fn(() => {
                throw new Error('Failed to get appData path')
            }),
            setPath: vi.fn(),
            setAppLogsPath: vi.fn(),
            commandLine: { appendSwitch: vi.fn() }
        } as unknown as App
        const locations = configureStoragePaths(app)
        expect(app.getPath).not.toHaveBeenCalled()
        expect(app.getAppPath).not.toHaveBeenCalled()
        expect(locations.root).toBe('E:\\Isolated')
        expect(process.env.ITER_STORE).toBe(locations.store)
        expect(process.env.TEMP).toBe(locations.temp)
        expect(app.setPath).toHaveBeenCalledWith('sessionData', locations.sessionData)
        expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('disk-cache-dir', locations.cache)
    })

    it('reports a failed explicit data path without silently redirecting user data', () => {
        vi.stubEnv('ITER_DATA_DIR', 'E:\\Explicit')
        vi.mocked(mkdirSync).mockImplementationOnce(() => {
            throw new Error('Read-only explicit directory')
        })
        const app = { isPackaged: true, getAppPath: () => 'E:\\ITER', getPath: () => 'E:\\Profile' } as unknown as App
        expect(() => configureStoragePaths(app)).toThrow('Read-only explicit directory')
        expect(mkdirSync).toHaveBeenCalledTimes(1)
    })
})
