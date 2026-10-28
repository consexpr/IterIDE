import { app } from 'electron'
import { lstatSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { crc32 } from 'node:zlib'
import { openPromise, type Entry, type ZipFile } from 'yauzl'
import type { ImportSummary } from '../../shared/config'
import { SettingsStore } from '../settings'
import {
    configPath,
    directories,
    isWithin,
    limits,
    parseJson,
    portableSettings,
    validateManifest,
    validateName
} from './common'

let importing = false

async function readEntry(zip: ZipFile, entry: Entry, maximum: number): Promise<Buffer> {
    if (entry.uncompressedSize > maximum) throw new Error(`Config entry is too large: ${entry.fileName}`)
    const stream = await zip.openReadStreamPromise(entry)
    const chunks: Buffer[] = []
    let size = 0,
        checksum = 0
    for await (const chunk of stream) {
        size += chunk.length
        if (size > maximum || size > entry.uncompressedSize) {
            stream.destroy()
            throw new Error(`Config entry exceeds its size limit: ${entry.fileName}`)
        }
        checksum = crc32(chunk, checksum)
        chunks.push(chunk)
    }
    if (size !== entry.uncompressedSize || checksum !== entry.crc32)
        throw new Error(`Corrupt config entry: ${entry.fileName}`)
    return Buffer.concat(chunks, size)
}

async function inventory(zip: ZipFile): Promise<Entry[]> {
    if (zip.entryCount > limits.entries) throw new Error('Config archive has too many entries')
    const entries: Entry[] = []
    const names = new Map<string, boolean>()
    let total = 0
    for await (const entry of zip.eachEntry()) {
        const name = entry.fileName
        validateName(name)
        const directory = name.endsWith('/')
        const key = name.replace(/\/$/, '').toLowerCase()
        if (names.has(key)) throw new Error(`Duplicate config archive path: ${name}`)
        names.set(key, directory)
        const mode = (entry.externalFileAttributes >>> 16) & 0xf000
        if ((mode && mode !== (directory ? 0x4000 : 0x8000)) || entry.isEncrypted()) {
            throw new Error(`Unsupported config archive entry: ${name}`)
        }
        if (
            entry.uncompressedSize > limits.file ||
            (total += entry.uncompressedSize) > limits.total ||
            (directory && entry.uncompressedSize !== 0)
        )
            throw new Error('Config archive exceeds size limits')
        entries.push(entry)
    }
    for (const name of names.keys()) {
        const parts = name.split('/')
        for (let i = 1; i < parts.length; i++) {
            if (names.get(parts.slice(0, i).join('/')) === false)
                throw new Error(`Conflicting config archive path: ${name}`)
        }
    }
    if (!names.has('manifest.json') || !names.has('settings.json'))
        throw new Error('Config manifest or settings are missing')
    return entries
}

/** The staged files and backup live on the same volume; swaps run without yielding. */
function replace(stage: string, settings: SettingsStore): string {
    const root = app.getPath('userData')
    const backup = mkdtempSync(path.join(root, `config-backup-${new Date().toISOString().replace(/[:.]/g, '-')}-`))
    const moved: { name: string; hadOriginal: boolean; installed: boolean }[] = []
    try {
        for (const name of ['settings.json', ...directories]) {
            const item = { name, hadOriginal: false, installed: false }
            moved.push(item)
            const destination = path.join(root, name)
            let exists = false
            try {
                lstatSync(destination)
                exists = true
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            }
            if (exists) {
                renameSync(destination, path.join(backup, name))
                item.hadOriginal = true
            }
            renameSync(path.join(stage, name), destination)
            item.installed = true
        }
        // Use SettingsStore's upgrade/deep-merge behavior, starting from the imported file and defaults.
        const replacement = new SettingsStore().set({})
        // Existing consumers retain this store, whose public get() object must now reflect replacement.
        const current = settings.get()
        for (const key of Object.keys(current)) delete (current as unknown as Record<string, unknown>)[key]
        Object.assign(current, replacement)
        return backup
    } catch (error) {
        const failures: unknown[] = [error]
        for (const item of moved.reverse()) {
            try {
                const destination = path.join(root, item.name)
                if (item.installed) rmSync(destination, { recursive: true, force: true })
                if (item.hadOriginal) renameSync(path.join(backup, item.name), destination)
            } catch (failure) {
                failures.push(failure)
            }
        }
        if (failures.length > 1)
            throw new AggregateError(failures, `Config rollback failed; originals are in ${backup}`)
        throw error
    }
}

/** No dialogs or notifications here; IPC owns interaction and refreshes themes/plugins. */
export async function importConfig(sourcePath: string, settings: SettingsStore): Promise<ImportSummary> {
    if (importing) throw new Error('A configuration import is already in progress')
    importing = true
    let zip: ZipFile | undefined, stage: string | undefined
    try {
        if ((await stat(sourcePath)).size > limits.total) throw new Error('Config archive is too large')
        zip = await openPromise(sourcePath, { autoClose: false, strictFileNames: true, validateEntrySizes: true })
        const entries = await inventory(zip)
        const manifest = entries.find((entry) => entry.fileName === 'manifest.json')!
        const version = validateManifest(await readEntry(zip, manifest, limits.manifest))
        // All entries have passed structural/path/size checks. Migrate v1 by selecting only
        // today's configuration; never extract legacy plugin code or newly excluded assets.
        const configuration = entries.filter((entry) => {
            if (entry.fileName === 'manifest.json') return false
            if (configPath(entry.fileName)) return true
            if (version === 1) return false
            throw new Error(`Not a configuration path: ${entry.fileName}`)
        })
        const settingsEntry = configuration.find((entry) => entry.fileName === 'settings.json')!
        const imported = portableSettings(parseJson(await readEntry(zip, settingsEntry, limits.settings), 'settings'))
        stage = await mkdtemp(path.join(app.getPath('userData'), '.config-import-'))
        const summary: ImportSummary = { settings: true, themes: 0, fonts: 0, plugins: 0, backupDir: '' }
        for (const dir of directories) await mkdir(path.join(stage, dir))
        await writeFile(path.join(stage, 'settings.json'), JSON.stringify(imported, null, 2), 'utf8')
        for (const entry of configuration) {
            const kind = directories.find((dir) => entry.fileName.startsWith(`${dir}/`))
            if (!kind) continue
            const target = path.resolve(stage, entry.fileName)
            if (!isWithin(stage, target)) throw new Error(`Unsafe config archive path: ${entry.fileName}`)
            if (entry.fileName.endsWith('/')) await mkdir(target, { recursive: true })
            else {
                await mkdir(path.dirname(target), { recursive: true })
                await writeFile(target, await readEntry(zip, entry, limits.file), { flag: 'wx' })
                summary[kind]++
            }
        }
        zip.close()
        zip = undefined
        summary.backupDir = replace(stage, settings)
        return summary
    } finally {
        try {
            zip?.close()
            if (stage) await rm(stage, { recursive: true, force: true })
        } finally {
            importing = false
        }
    }
}
