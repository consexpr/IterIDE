import { app } from 'electron'
import {
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    writeFileSync
} from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { defaultSettings, type AppSettings } from '../shared/settings'
import { validateSettingsPatch } from '../shared/settingsValidation'
import { listThemes } from './themes'
import { atomicJsonSync } from './problem/atomic'
import { relocatedLegacyPath } from './legacyStorage'

const FONT_EXT = /\.(ttf|otf|woff2?)$/i

/** JSON settings in userData. Deep-merges with defaults so new keys appear after upgrades. */
export class SettingsStore {
    private data: AppSettings
    private readonly file: string
    private readonly root: string
    private damaged?: Buffer

    constructor() {
        this.root = app.getPath('userData')
        this.file = path.join(this.root, 'settings.json')
        this.data = merge(defaultSettings(), this.readFile())
        this.data.recentFiles = this.data.recentFiles.map(relocatedLegacyPath)
        delete (this.data as unknown as Record<string, unknown>).lastFolder
        for (const d of Object.values(this.userDirs())) mkdirSync(d, { recursive: true })
    }

    get(): AppSettings {
        return this.data
    }

    set(patch: Partial<AppSettings>): AppSettings {
        if (!isObj(patch)) throw new Error('设置更新必须是对象')
        const next = merge(this.data, validateSettingsPatch(patch))
        this.preserveDamaged()
        atomicJsonSync(this.file, next)
        this.data = next
        return this.data
    }

    /** Replace portable configuration, including removed map keys, while retaining local history. */
    replaceConfig(patch: Partial<AppSettings>): AppSettings {
        const next = merge(defaultSettings(), validateSettingsPatch(patch))
        next.recentFiles = this.data.recentFiles
        // Persist first so a failed write leaves live settings unchanged.
        this.preserveDamaged()
        atomicJsonSync(this.file, next)
        const current = this.data as unknown as Record<string, unknown>
        for (const key of Object.keys(current)) delete current[key]
        Object.assign(current, next)
        return this.data
    }

    userDirs(): { themes: string; fonts: string; plugins: string } {
        return {
            themes: path.join(this.root, 'themes'),
            fonts: path.join(this.root, 'fonts'),
            plugins: path.join(this.root, 'plugins')
        }
    }

    listUserThemes(): unknown[] {
        return listThemes(this.userDirs().themes)
    }

    /** Font family is the file name without extension; served via iter://fonts/<file>. */
    listUserFonts(): { family: string; file: string }[] {
        return safeReaddir(this.userDirs().fonts)
            .filter((f) => FONT_EXT.test(f))
            .map((f) => ({ family: f.replace(FONT_EXT, ''), file: f }))
    }

    private readFile(): Partial<AppSettings> {
        if (!existsSync(this.file)) return {}
        let bytes: Buffer | undefined
        try {
            bytes = readFileSync(this.file)
            const value: unknown = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))
            return validateSettingsPatch(value, {
                recover: true,
                invalid: () => {
                    this.damaged = bytes
                }
            })
        } catch {
            this.damaged = bytes
            return {}
        }
    }

    private preserveDamaged(): void {
        if (!this.damaged) return
        const backup = `${this.file}.corrupt-${createHash('sha256').update(this.damaged).digest('hex')}.json`
        try {
            const handle = openSync(backup, 'wx', 0o600)
            try {
                writeFileSync(handle, this.damaged)
                fsyncSync(handle)
            } finally {
                closeSync(handle)
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !readFileSync(backup).equals(this.damaged))
                throw error
        }
        this.damaged = undefined
    }
}

function safeReaddir(dir: string): string[] {
    try {
        return readdirSync(dir)
    } catch {
        return []
    }
}

function isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function merge<T>(base: T, patch: unknown): T {
    if (!isObj(base) || !isObj(patch)) return (patch === undefined ? base : patch) as T
    const out: Record<string, unknown> = { ...base }
    for (const [k, v] of Object.entries(patch)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
        out[k] = isObj(v) ? merge(isObj(out[k]) ? out[k] : {}, v) : v
    }
    return out as T
}
