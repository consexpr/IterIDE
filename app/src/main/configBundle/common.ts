import { app } from 'electron'
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { defaultSettings, migrateSettings, type AppSettings } from '../../shared/settings'
import { validateSettingsPatch } from '../../shared/settingsValidation'
import { LEGACY_CONFIG_FORMAT, LEGACY_STORE_DIRECTORY } from '../../shared/legacyBrand'

export const directories = ['themes', 'fonts'] as const
export const contents = ['settings.json', ...directories.map((name) => `${name}/`)]
export const limits = {
    entries: 10_000,
    file: 128 * 1024 * 1024,
    total: 512 * 1024 * 1024,
    settings: 1024 * 1024,
    manifest: 64 * 1024
}

export interface Manifest {
    format: 'iter-config'
    version: 2
    appVersion: string
    createdAt: string
    contents: string[]
}

export function bundledRoot(): string {
    return path.join(
        app.isPackaged ? process.resourcesPath : app.getAppPath(),
        app.isPackaged ? 'toolchain' : 'resources/toolchain'
    )
}

export function isWithin(root: string, file: string): boolean {
    const relative = path.relative(root, file)
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/** Never include source files, plugin code, backups or problem/test data inside config folders. */
export function excluded(name: string): boolean {
    return (
        name
            .split('/')
            .some(
                (part) =>
                    part.toLowerCase() === LEGACY_STORE_DIRECTORY ||
                    /^(?:\.iter|problems?|library|plugins|plugin-data|tests?|testdata|\.git|\.svn|\.hg|tmp|temp)$/i.test(
                        part
                    ) ||
                    /(?:\.conflict-|\.(?:tmp|temp|lock|swp|swo)$|~$|^([.~]lock|~\$))/i.test(part)
            ) || /\.(?:cpp|cc|cxx|c\+\+|c|h|hpp|js|cjs|mjs|jsx|ts|tsx|py|exe|dll|sh|bat|ps1|in|out|ans)$/i.test(name)
    )
}

/** The same allowlist applies to bundle collection/import and both directions of sync. */
export function configPath(name: string): boolean {
    try {
        validateName(name)
    } catch {
        return false
    }
    return !excluded(name) && (name === 'settings.json' || directories.some((dir) => name.startsWith(`${dir}/`)))
}

/** A portable subset of filenames also prevents Windows ADS, aliases and device paths. */
export function validateName(name: string): void {
    const parts = name.replace(/\/$/, '').split('/')
    if (
        !name ||
        name.length > 1024 ||
        parts.some(
            (p) =>
                !p ||
                p === '.' ||
                p === '..' ||
                /[\\:\x00-\x1f<>"|?*]/.test(p) ||
                /[. ]$/.test(p) ||
                /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)
        )
    ) {
        throw new Error(`Unsafe config archive path: ${name}`)
    }
}

export function object(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseJson(data: Buffer, label: string): Record<string, unknown> {
    let value: unknown
    try {
        value = JSON.parse(data.toString('utf8'))
    } catch {
        throw new Error(`Invalid ${label} JSON`)
    }
    if (!object(value)) throw new Error(`Invalid ${label}: expected an object`)
    const check = (v: unknown, depth: number): void => {
        if (depth > 32) throw new Error(`${label} is too deeply nested`)
        if (v && typeof v === 'object')
            for (const [key, child] of Object.entries(v)) {
                if (['__proto__', 'constructor', 'prototype'].includes(key))
                    throw new Error(`Unsafe ${label} key: ${key}`)
                check(child, depth + 1)
            }
    }
    check(value, 0)
    return value
}

/** Return the source version so import can discard legacy non-configuration entries. */
export function validateManifest(data: Buffer): 1 | 2 {
    const manifest = parseJson(data, 'manifest')
    const declared = manifest.contents
    const expected = manifest.version === 1 ? [...contents, 'plugins/'] : contents
    if (
        (manifest.format !== 'iter-config' && manifest.format !== LEGACY_CONFIG_FORMAT) ||
        (manifest.version !== 1 && manifest.version !== 2) ||
        typeof manifest.appVersion !== 'string' ||
        typeof manifest.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(manifest.createdAt)) ||
        !Array.isArray(declared) ||
        declared.length !== expected.length ||
        !expected.every((entry) => declared.includes(entry))
    ) {
        throw new Error('Invalid or unsupported config manifest')
    }
    return manifest.version
}

export function portableSettings(input: unknown, mode: 'export' | 'import' = 'import'): Partial<AppSettings> {
    // Copy before deleting transient keys or normalizing paths; exporting must not mutate the store.
    const settings = parseJson(Buffer.from(JSON.stringify(input)), 'settings')
    delete settings.recentFiles
    delete settings.lastFolder
    migrateSettings(settings)
    const defaults = defaultSettings()
    const validated = validateSettingsPatch(settings)
    for (const key of Object.keys(settings)) delete settings[key]
    Object.assign(settings, validated)
    if (object(settings.toolchain)) {
        for (const key of ['compiler', 'gdb', 'clangd', 'clangFormat'] as const) {
            const tool = settings.toolchain[key]
            if (typeof tool !== 'string') continue
            const configured = tool.trim()
            if (!path.posix.isAbsolute(configured) && !path.win32.isAbsolute(configured)) continue
            let usable = false
            let bundled = isWithin(bundledRoot(), configured)
            try {
                bundled ||= isWithin(realpathSync(bundledRoot()), realpathSync(configured))
            } catch {
                /* Either path may not exist on this computer. */
            }
            try {
                usable = statSync(configured).isFile()
                accessSync(configured, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
            } catch {
                usable = false
            }
            if (bundled || (mode === 'import' && !usable)) settings.toolchain[key] = defaults.toolchain[key]
        }
    }
    return settings as Partial<AppSettings>
}
