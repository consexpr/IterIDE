import { app } from 'electron'
import { lstat, readdir } from 'node:fs/promises'
import type { SettingsStore } from '../settings'
import { configPath, directories, excluded, limits, portableSettings, validateName } from './common'
import { missing, readLocal, safePath } from './files'
import type { ZipSource } from './zip'

export interface CollectOptions {
    maxBytes?: number
    /** Sync skips unsafe/oversized entries; an export fails instead of making a partial bundle. */
    skip?: (name: string, reason: string) => void
}

export function settingsContent(settings: SettingsStore): Buffer {
    return Buffer.from(JSON.stringify(portableSettings(settings.get(), 'export'), null, 2))
}

/** Single configuration collector for ZIP export and GitHub sync. No plugin/store traversal. */
export async function* collectConfig(settings: SettingsStore, options: CollectOptions = {}): AsyncGenerator<ZipSource> {
    const root = app.getPath('userData')
    const maximum = Math.min(options.maxBytes ?? limits.file, limits.file)
    const skip = (name: string, reason: string): void => {
        if (!options.skip) throw new Error(reason)
        options.skip(name, reason)
    }
    await safePath(root, '')
    try {
        await safePath(root, 'settings.json')
        const data = settingsContent(settings)
        if (data.length > Math.min(maximum, limits.settings)) skip('settings.json', 'Settings are too large')
        else yield { name: 'settings.json', data }
    } catch (error) {
        skip('settings.json', `Cannot collect settings: ${(error as Error).message}`)
    }

    async function* walk(relative: string): AsyncGenerator<ZipSource> {
        let target: string
        try {
            target = await safePath(root, relative)
            const info = await lstat(target)
            if (!info.isDirectory()) throw new Error(`Not a configuration directory: ${relative}`)
        } catch (error) {
            if (missing(error)) return
            skip(relative, `Cannot collect linked or unsafe config directory: ${relative}`)
            return
        }
        for (const entry of await readdir(target, { withFileTypes: true })) {
            const name = `${relative}/${entry.name}`
            if (excluded(name)) continue
            try {
                validateName(name)
            } catch {
                skip(name, `Unsafe config path: ${name}`)
                continue
            }
            if (!configPath(name)) continue
            if (entry.isSymbolicLink()) skip(name, `Cannot collect symbolic link: ${name}`)
            else if (entry.isDirectory()) {
                yield { name: `${name}/`, data: Buffer.alloc(0) }
                yield* walk(name)
            } else if (entry.isFile()) {
                try {
                    const data = await readLocal(root, name, maximum)
                    if (data) yield { name, data }
                } catch (error) {
                    skip(name, `Cannot collect config file ${name}: ${(error as Error).message}`)
                }
            } else skip(name, `Unsupported config file: ${name}`)
        }
    }
    for (const dir of directories) {
        yield { name: `${dir}/`, data: Buffer.alloc(0) }
        yield* walk(dir)
    }
}
