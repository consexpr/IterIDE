import { closeSync, mkdirSync, openSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { App } from 'electron'
import { migrateLegacyStorage, resetLegacyStorage } from './legacyStorage'

interface StorageOptions {
    platform: NodeJS.Platform
    packaged: boolean
    application: string
    appData: string
    home: string
    env: NodeJS.ProcessEnv
}

export interface StoragePaths {
    root: string
    userData: string
    sessionData: string
    cache: string
    logs: string
    crashDumps: string
    temp: string
    store: string
}

/** Never resolve a relative override against an unpredictable launcher directory. */
function checkedDirectory(value: string, name: string, platform: NodeJS.Platform): string {
    const paths = platform === 'win32' ? path.win32 : path
    if (!paths.isAbsolute(value)) throw new Error(`${name} 必须是绝对路径`)
    return paths.resolve(value)
}

export function resolveStoragePaths(options: StorageOptions): StoragePaths {
    const paths = options.platform === 'win32' ? path.win32 : path
    const env = options.env
    const isolated = !!env.ITER_DATA_DIR || !options.packaged
    const defaultRoot = options.packaged
        ? paths.join(options.appData, 'ITER')
        : paths.resolve(options.application, '..', 'sandbox', 'runtime')
    const root = checkedDirectory(env.ITER_DATA_DIR || defaultRoot, 'ITER_DATA_DIR', options.platform)
    return {
        root,
        // Published builds use the ITER profile; legacy content is copied before these paths are opened.
        userData: isolated ? paths.join(root, 'userData') : root,
        // Chromium's old Local Storage holds watches and panel preferences in userData.
        sessionData: isolated ? paths.join(root, 'sessionData') : root,
        cache: paths.join(root, 'cache'),
        logs: paths.join(root, 'logs'),
        crashDumps: paths.join(root, 'crashDumps'),
        temp: paths.join(root, 'temp'),
        store: checkedDirectory(
            env.ITER_STORE || (isolated ? paths.join(root, 'store') : paths.join(options.home, '.iter')),
            'ITER_STORE',
            options.platform
        )
    }
}

/** Call before app.ready, single-instance locking, settings, or creating sessions. */
export function configureStoragePaths(app: App): StoragePaths {
    const isolated = !!process.env.ITER_DATA_DIR
    const options = {
        platform: process.platform,
        packaged: app.isPackaged,
        application: isolated ? '' : app.getAppPath(),
        // An explicit isolated root must also work on machines where appData cannot be resolved.
        appData: !isolated && app.isPackaged ? app.getPath('appData') : '',
        home: os.homedir(),
        env: process.env
    }
    const locations = resolveStoragePaths(options)
    resetLegacyStorage()
    if (options.packaged && !isolated)
        migrateLegacyStorage({
            appData: options.appData,
            home: options.home,
            userData: locations.userData,
            store: locations.store,
            migrateStore: !options.env.ITER_STORE
        })
    const prepare = (candidate: StoragePaths): void => {
        // A directory can exist but still be read-only (e.g. an install under Program Files).
        // Test real writes rather than relying on Windows' limited access(W_OK) behavior.
        for (const directory of Object.values(candidate)) {
            mkdirSync(directory, { recursive: true })
            const probe = path.join(directory, `.iter-write-${process.pid}-${Date.now()}`)
            const fd = openSync(probe, 'wx')
            closeSync(fd)
            unlinkSync(probe)
        }
    }
    // Never silently redirect an established store or settings directory after a write error.
    prepare(locations)
    process.env.ITER_DATA_DIR = locations.root
    process.env.ITER_STORE = locations.store
    process.env.TEMP = locations.temp
    process.env.TMP = locations.temp
    process.env.TMPDIR = locations.temp
    app.setPath('userData', locations.userData)
    app.setPath('sessionData', locations.sessionData)
    app.setPath('temp', locations.temp)
    app.setPath('crashDumps', locations.crashDumps)
    app.setAppLogsPath(locations.logs)
    app.commandLine.appendSwitch('disk-cache-dir', locations.cache)
    return locations
}
