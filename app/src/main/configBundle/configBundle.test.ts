import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openPromise } from 'yauzl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../../shared/settings'

const electron = vi.hoisted(() => ({
    root: '',
    appRoot: '',
    handlers: new Map<string, (...args: any[]) => any>(),
    save: vi.fn(),
    open: vi.fn(),
    send: vi.fn(),
    reload: vi.fn(async () => {})
}))
vi.mock('electron', () => ({
    app: {
        getPath: () => electron.root,
        getAppPath: () => electron.appRoot,
        getVersion: () => '0.1.0',
        isPackaged: false
    },
    dialog: { showSaveDialog: electron.save, showOpenDialog: electron.open },
    ipcMain: {
        handle: (channel: string, fn: (...args: any[]) => any) => electron.handlers.set(channel, fn),
        on: vi.fn()
    },
    shell: {}
}))
vi.mock('../plugins/manager', () => ({
    PluginManager: class {
        loadAll = async (): Promise<void> => {}
        reload = electron.reload
    }
}))
vi.mock('../judge/engine', () => ({ JudgeEngine: class {} }))
vi.mock('../debug/manager', () => ({ DebugManager: class {} }))
vi.mock('../lsp/clangd', () => ({ ClangdBridge: class {} }))

import { SettingsStore } from '../settings'
import { registerIpc } from '../ipc'
import { contents, limits } from './common'
import { exportConfig } from './export'
import { collectConfig } from './collect'
import { importConfig } from './import'
import { writeZip, type ZipSource } from './zip'

let temp: string
function useRoot(name: string): SettingsStore {
    electron.root = path.join(temp, name)
    mkdirSync(electron.root, { recursive: true })
    return new SettingsStore()
}
function file(name: string, data: string | Buffer): void {
    const target = path.join(electron.root, name)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, data)
}
function validEntries(settings: unknown = { theme: 'custom' }): ZipSource[] {
    return [
        {
            name: 'manifest.json',
            data: Buffer.from(
                JSON.stringify({
                    format: 'iter-config',
                    version: 2,
                    appVersion: '0.1.0',
                    createdAt: '2026-10-19T00:00:00Z',
                    contents
                })
            )
        },
        { name: 'settings.json', data: Buffer.from(JSON.stringify(settings)) },
        ...['themes/', 'fonts/'].map((name) => ({ name, data: Buffer.alloc(0) }))
    ]
}
async function bundle(entries = validEntries()): Promise<string> {
    const target = path.join(temp, `bundle-${Math.random()}.iterconf`)
    await writeZip(target, entries)
    return target
}
async function readBundle(target: string): Promise<Map<string, Buffer>> {
    const zip = await openPromise(target, { autoClose: false })
    const result = new Map<string, Buffer>()
    try {
        for await (const entry of zip.eachEntry()) {
            const data: Buffer[] = []
            for await (const chunk of await zip.openReadStreamPromise(entry)) data.push(chunk)
            result.set(entry.fileName, Buffer.concat(data))
        }
        return result
    } finally {
        zip.close()
    }
}
beforeEach(() => {
    temp = mkdtempSync(path.join(os.tmpdir(), 'iter-config-'))
    electron.appRoot = path.join(temp, 'app')
    vi.clearAllMocks()
    electron.handlers.clear()
})
afterEach(() => {
    vi.restoreAllMocks()
    // temp is an OS-created absolute test directory, never a computed project path.
    rmSync(temp, { recursive: true, force: true })
})

describe('configuration bundles', () => {
    it('imports the previous brand format, migrates built-in themes and writes only the new format', async () => {
        const store = useRoot('previous-brand')
        const entries = validEntries({ theme: 'naven-paper' })
        entries[0].data = Buffer.from(entries[0].data.toString().replace('iter-config', 'naven-config'))
        await importConfig(await bundle(entries), store)
        expect(store.get().theme).toBe('iter-paper')
        file('themes/.naven/private.json', '{}')
        const exported = await readBundle(await exportConfig(path.join(temp, 'renamed.iterconf'), store))
        expect(JSON.parse(exported.get('manifest.json')!.toString()).format).toBe('iter-config')
        expect(exported.has('themes/.naven/private.json')).toBe(false)
    })

    it('migrates a v1 bundle to current configuration while ignoring plugin code and excluded assets', async () => {
        const store = useRoot('legacy')
        file('plugins/helper/index.cjs', 'installed plugin')
        const entries: ZipSource[] = [
            {
                name: 'manifest.json',
                data: Buffer.from(
                    JSON.stringify({
                        format: 'iter-config',
                        version: 1,
                        appVersion: '0.1.0',
                        createdAt: '2026-10-19T00:00:00Z',
                        contents: ['settings.json', 'themes/', 'fonts/', 'plugins/']
                    })
                )
            },
            {
                name: 'settings.json',
                data: Buffer.from(
                    JSON.stringify({
                        theme: 'legacy',
                        editor: { fontSize: 23 },
                        keybindings: { 'file.save': 'Ctrl+Alt+S' },
                        template: '// legacy template $0'
                    })
                )
            },
            ...['themes/', 'fonts/', 'plugins/', 'plugins/helper/', 'plugins/other/'].map((name) => ({
                name,
                data: Buffer.alloc(0)
            })),
            { name: 'themes/legacy.json', data: Buffer.from('{"id":"legacy"}') },
            { name: 'fonts/custom.woff2', data: Buffer.from([0, 255, 1]) },
            { name: 'themes/legacy.js', data: Buffer.from('legacy script') },
            { name: 'themes/legacy.conflict-device.json', data: Buffer.from('{}') },
            { name: 'plugins/helper/index.cjs', data: Buffer.from('must not overwrite installed plugin') },
            { name: 'plugins/other/iter-plugin.json', data: Buffer.from('{"id":"other"}') },
            { name: 'plugins/other/index.cjs', data: Buffer.from('must not install plugin') }
        ]
        const summary = await importConfig(await bundle(entries), store)
        expect(summary).toMatchObject({ settings: true, themes: 1, fonts: 1, plugins: 0 })
        expect(store.get()).toMatchObject({
            theme: 'legacy',
            editor: { fontSize: 23 },
            keybindings: { 'file.save': 'Ctrl+Alt+S' },
            template: '// legacy template $0',
            pluginEnabled: {}
        })
        expect(readFileSync(path.join(electron.root, 'themes/legacy.json'), 'utf8')).toBe('{"id":"legacy"}')
        expect(readFileSync(path.join(electron.root, 'fonts/custom.woff2'))).toEqual(Buffer.from([0, 255, 1]))
        expect(readFileSync(path.join(electron.root, 'plugins/helper/index.cjs'), 'utf8')).toBe('installed plugin')
        expect(existsSync(path.join(electron.root, 'plugins/other'))).toBe(false)
        expect(existsSync(path.join(electron.root, 'themes/legacy.js'))).toBe(false)
        expect(existsSync(path.join(electron.root, 'themes/legacy.conflict-device.json'))).toBe(false)
        const migrated = await readBundle(await exportConfig(path.join(temp, 'migrated.iterconf'), store))
        expect(JSON.parse(migrated.get('manifest.json')!.toString())).toMatchObject({ version: 2, contents })
        expect([...migrated.keys()].sort()).toEqual(
            ['manifest.json', 'settings.json', 'themes/', 'themes/legacy.json', 'fonts/', 'fonts/custom.woff2'].sort()
        )
    })

    it('roundtrips settings, nested themes, binary fonts and plugin states without plugin code into fresh userData', async () => {
        const source = useRoot('source')
        source.set({
            theme: 'personal',
            editor: { ...defaultSettings().editor, fontSize: 21 },
            recentFiles: ['private.cpp'],
            pluginEnabled: { helper: false }
        })
        file('themes/personal/theme.json', '{"id":"personal"}')
        file('themes/personal/assets/背景.png', Buffer.from([0, 255, 13, 10]))
        file('fonts/custom.woff2', Buffer.from([1, 0, 2, 255]))
        file('plugins/helper/package.json', '{"main":"index.cjs"}')
        file('plugins/helper/index.cjs', 'exports.activate = () => {}')
        file('themes/empty/.keep', '')
        mkdirSync(path.join(electron.root, 'plugins/empty'))
        const target = path.join(temp, 'setup.iterconf')
        expect(await exportConfig(target, source)).toBe(target)
        const archive = await readBundle(target)
        const collected = new Map<string, Buffer>()
        for await (const entry of collectConfig(source)) collected.set(entry.name, entry.data)
        expect(new Map([...archive].filter(([name]) => name !== 'manifest.json'))).toEqual(collected)
        expect(JSON.parse(archive.get('manifest.json')!.toString())).toMatchObject({
            format: 'iter-config',
            version: 2,
            appVersion: '0.1.0',
            contents
        })
        const saved = JSON.parse(archive.get('settings.json')!.toString())
        expect(saved).not.toHaveProperty('recentFiles')
        expect(source.get().recentFiles).toEqual(['private.cpp'])
        const destination = useRoot('destination')
        const summary = await importConfig(target, destination)
        expect(summary).toMatchObject({ settings: true, themes: 3, fonts: 1, plugins: 0 })
        expect(existsSync(summary.backupDir)).toBe(true)
        expect(destination.get()).toEqual({ ...source.get(), recentFiles: [] })
        for (const [name, data] of archive) {
            if (/^(themes|fonts|plugins)\/.+[^/]$/.test(name))
                expect(readFileSync(path.join(electron.root, name))).toEqual(data)
        }
        expect(existsSync(path.join(electron.root, 'plugins/empty'))).toBe(false)
        expect([...archive.keys()].some((name) => name.startsWith('plugins/'))).toBe(false)
        expect(JSON.parse(readFileSync(path.join(electron.root, 'settings.json'), 'utf8'))).toEqual(destination.get())
    })

    it('backs up originals and replaces settings and directories instead of retaining old values', async () => {
        const store = useRoot('existing')
        store.set({
            theme: 'old',
            recentFiles: ['old.cpp'],
            editor: { ...defaultSettings().editor, fontSize: 40, vim: true }
        })
        file('themes/old.json', 'old theme')
        file('fonts/old.ttf', 'old font')
        file('plugins/old/index.cjs', 'old plugin')
        const originalSettings = readFileSync(path.join(electron.root, 'settings.json'))
        const current = store.get()
        const source = await bundle(
            validEntries({ editor: { fontSize: 19 }, recentFiles: ['injected.cpp'], lastFolder: 'injected' } as never)
        )
        const summary = await importConfig(source, store)
        expect(store.get()).toBe(current)
        expect(store.get()).toEqual({ ...defaultSettings(), editor: { ...defaultSettings().editor, fontSize: 19 } })
        expect(path.basename(summary.backupDir)).toMatch(/^config-backup-/)
        expect(readFileSync(path.join(summary.backupDir, 'settings.json'))).toEqual(originalSettings)
        expect(readFileSync(path.join(summary.backupDir, 'themes/old.json'), 'utf8')).toBe('old theme')
        expect(readFileSync(path.join(summary.backupDir, 'fonts/old.ttf'), 'utf8')).toBe('old font')
        expect(readFileSync(path.join(electron.root, 'plugins/old/index.cjs'), 'utf8')).toBe('old plugin')
        for (const dir of ['themes', 'fonts']) expect(readdirSync(path.join(electron.root, dir))).toEqual([])
        expect(readdirSync(electron.root).filter((name) => name.startsWith('.config-import-'))).toEqual([])
    })

    it('resets missing, foreign and bundled tool paths while preserving an existing external executable', async () => {
        const store = useRoot('tools')
        const bundled = path.join(electron.appRoot, 'resources/toolchain/bin/g++.exe')
        mkdirSync(path.dirname(bundled), { recursive: true })
        writeFileSync(bundled, '')
        chmodSync(bundled, 0o755)
        const external = path.join(temp, 'external-clang-format')
        writeFileSync(external, '')
        chmodSync(external, 0o755)
        const settings = {
            toolchain: {
                compiler: bundled,
                gdb: path.join(temp, 'missing-gdb'),
                clangd: '/another/computer/clangd',
                clangFormat: external
            }
        }
        await importConfig(await bundle(validEntries(settings)), store)
        expect(store.get().toolchain).toEqual({ ...defaultSettings().toolchain, clangFormat: external })
        store.set({ toolchain: { ...store.get().toolchain, compiler: bundled, gdb: 'custom-gdb' } })
        const exported = JSON.parse(
            (await readBundle(await exportConfig(path.join(temp, 'tools.iterconf'), store)))
                .get('settings.json')!
                .toString()
        )
        expect(exported.toolchain.compiler).toBe('g++')
        expect(exported.toolchain.gdb).toBe('custom-gdb')
        expect(store.get().toolchain.compiler).toBe(bundled)
    })

    it('excludes source files, problem folders and test data without reading project data', async () => {
        const store = useRoot('excluded')
        for (const name of [
            'solution.cpp',
            '.iter/problem.json',
            'themes/hidden.CPP',
            'themes/.iter/problem.json',
            'plugins/helper/tests/input.txt',
            'plugins/helper/input.in',
            'plugins/helper/output.out',
            'plugins/helper/output.ans'
        ])
            file(name, 'private data')
        file('themes/theme.json', '{}')
        const archive = await readBundle(await exportConfig(path.join(temp, 'excluded.iterconf'), store))
        expect([...archive.keys()].filter((name) => !name.endsWith('/'))).toEqual([
            'manifest.json',
            'settings.json',
            'themes/theme.json'
        ])
    })

    it('defers checking external tool existence until import on the destination computer', async () => {
        const source = useRoot('source-tools')
        const futureCompiler = path.join(temp, 'destination-only-compiler')
        source.set({ toolchain: { ...source.get().toolchain, compiler: futureCompiler } })
        const target = await exportConfig(path.join(temp, 'future-tools.iterconf'), source)
        const settings = JSON.parse((await readBundle(target)).get('settings.json')!.toString())
        expect(settings.toolchain.compiler).toBe(futureCompiler)
        const destination = useRoot('destination-tools')
        writeFileSync(futureCompiler, '')
        chmodSync(futureCompiler, 0o755)
        await importConfig(target, destination)
        expect(destination.get().toolchain.compiler).toBe(futureCompiler)
    })

    it.each([
        '../outside.txt',
        'themes/../../outside.txt',
        '/outside.txt',
        'themes\\..\\outside.txt',
        'fonts/C:escape.ttf',
        'plugins/CON',
        'themes/trailing.'
    ])('rejects unsafe path %s without touching userData', async (name) => {
        const store = useRoot('unsafe')
        file('themes/original.json', 'original')
        const source = await bundle([...validEntries(), { name, data: Buffer.from('escape') }])
        await expect(importConfig(source, store)).rejects.toThrow()
        expect(readFileSync(path.join(electron.root, 'themes/original.json'), 'utf8')).toBe('original')
        expect(readdirSync(electron.root).some((item) => item.startsWith('config-backup-'))).toBe(false)
        expect(existsSync(path.join(temp, 'outside.txt'))).toBe(false)
    })

    it.each([
        'bad json',
        JSON.stringify({ format: 'iter-config', version: 3 }),
        JSON.stringify({ format: 'other', version: 2 }),
        JSON.stringify({ format: 'iter-config', version: 2, appVersion: '1', createdAt: 'invalid', contents })
    ])('rejects a bad manifest: %s', async (manifest) => {
        const store = useRoot('manifest')
        const entries = validEntries()
        entries[0].data = Buffer.from(manifest)
        await expect(importConfig(await bundle(entries), store)).rejects.toThrow(/manifest/i)
        expect(readdirSync(electron.root).sort()).toEqual(['fonts', 'plugins', 'themes'])
    })

    it('rejects missing manifests, invalid settings, conflicting names and problem data', async () => {
        const store = useRoot('invalid')
        const badSettings = validEntries()
        badSettings[1].data = Buffer.from('{"editor":{"__proto__":{"polluted":true}}}')
        for (const entries of [
            validEntries().slice(1),
            validEntries({ editor: null }),
            validEntries({ editor: { completion: { snippets: {} } } }),
            validEntries({ editor: { completion: { snippets: [{ trigger: 'ok', body: 42 }] } } }),
            validEntries({ keybindings: { 'file.save': 42 } }),
            validEntries({ toolchain: { parallel: 0 } }),
            validEntries({ toolchain: { compiler: 42 } }),
            validEntries({ pluginEnabled: { helper: 'false' } }),
            badSettings,
            [
                ...validEntries(),
                { name: 'themes/a', data: Buffer.from('file') },
                { name: 'themes/a/b', data: Buffer.from('child') }
            ],
            [
                ...validEntries(),
                { name: 'themes/A.json', data: Buffer.alloc(0) },
                { name: 'themes/a.json', data: Buffer.alloc(0) }
            ],
            [...validEntries(), { name: 'plugins/helper/index.cjs', data: Buffer.from('exports.activate = () => {}') }],
            [...validEntries(), { name: 'plugins/helper/.iter/problem.json', data: Buffer.from('{}') }]
        ]) {
            await expect(importConfig(await bundle(entries), store)).rejects.toThrow()
        }
        expect(readdirSync(electron.root).sort()).toEqual(['fonts', 'plugins', 'themes'])
    })

    it('rejects oversized metadata, symlink entries and corrupt CRCs', async () => {
        const store = useRoot('corrupt')
        const original = await bundle([...validEntries(), { name: 'themes/link', data: Buffer.from('target') }])
        const buffer = readFileSync(original)
        const headers: number[] = []
        for (let i = 0; i <= buffer.length - 4; i++) if (buffer.readUInt32LE(i) === 0x02014b50) headers.push(i)
        const last = headers.at(-1)!
        for (const mutate of [
            (copy: Buffer) => copy.writeUInt32LE(limits.file + 1, last + 24),
            (copy: Buffer) => copy.writeUInt32LE((0xa1ff << 16) >>> 0, last + 38),
            (copy: Buffer) => copy.writeUInt32LE(0, last + 16)
        ]) {
            const copy = Buffer.from(buffer)
            mutate(copy)
            const file = path.join(temp, `corrupt-${Math.random()}.iterconf`)
            writeFileSync(file, copy)
            await expect(importConfig(file, store)).rejects.toThrow()
        }
        expect(readdirSync(electron.root).sort()).toEqual(['fonts', 'plugins', 'themes'])
    })

    it('rolls back all swapped files and keeps live settings if persisting the replacement fails', async () => {
        const store = useRoot('rollback')
        store.set({ theme: 'original' })
        file('themes/original.json', 'original theme')
        file('fonts/original.ttf', 'original font')
        file('plugins/original/index.cjs', 'original plugin')
        const settings = readFileSync(path.join(electron.root, 'settings.json'))
        const fail = vi.spyOn(SettingsStore.prototype, 'set').mockImplementationOnce(() => {
            throw new Error('write failed')
        })
        await expect(importConfig(await bundle(), store)).rejects.toThrow('write failed')
        fail.mockRestore()
        expect(store.get().theme).toBe('original')
        expect(readFileSync(path.join(electron.root, 'settings.json'))).toEqual(settings)
        expect(readFileSync(path.join(electron.root, 'themes/original.json'), 'utf8')).toBe('original theme')
        expect(readFileSync(path.join(electron.root, 'fonts/original.ttf'), 'utf8')).toBe('original font')
        expect(readFileSync(path.join(electron.root, 'plugins/original/index.cjs'), 'utf8')).toBe('original plugin')
        expect(readdirSync(electron.root).some((name) => name.startsWith('.config-import-'))).toBe(false)
    })

    it('exports over an existing bundle and refuses to write inside configuration folders', async () => {
        const store = useRoot('overwrite')
        const target = path.join(temp, 'existing.iterconf')
        writeFileSync(target, 'old')
        await exportConfig(target, store)
        expect((await readBundle(target)).has('manifest.json')).toBe(true)
        await expect(exportConfig(path.join(store.userDirs().themes, 'bundle.iterconf'), store)).rejects.toThrow(
            /outside/
        )
    })
})

describe('configuration IPC', () => {
    const entry = 'file:///iter/renderer/index.html'
    const mainFrame = { url: entry }
    const webContents = { send: electron.send, mainFrame, isDestroyed: () => false }
    function setup(): SettingsStore {
        const store = useRoot('ipc')
        registerIpc(() => ({ isDestroyed: () => false, webContents }) as any, store, undefined, entry)
        return store
    }
    const call = (channel: string, ...args: unknown[]): Promise<any> =>
        electron.handlers.get(channel)!({ sender: webContents, senderFrame: mainFrame }, ...args)

    it('uses native dialogs and returns null on cancellation without changing files', async () => {
        setup()
        electron.save.mockResolvedValue({ canceled: true })
        electron.open.mockResolvedValue({ canceled: true, filePaths: [] })
        expect(await call('config:export')).toBeNull()
        expect(electron.save.mock.calls[0][1]).toMatchObject({
            defaultPath: expect.stringMatching(/^iter-config-\d{8}\.iterconf$/)
        })
        expect(await call('config:import')).toBeNull()
        expect(electron.open.mock.calls[0][1].filters[0].extensions).toEqual(['iterconf', 'navenconf'])
        expect(electron.reload).not.toHaveBeenCalled()
        expect(electron.send).not.toHaveBeenCalled()
    })

    it('exports/imports explicit paths silently and refreshes themes and plugins', async () => {
        const store = setup()
        const target = path.join(temp, 'ipc.iterconf')
        store.set({ theme: 'exported' })
        expect(await call('config:export', target)).toBe(target)
        store.set({ theme: 'changed' })
        expect(await call('config:import', target)).toMatchObject({ settings: true, themes: 0, fonts: 0, plugins: 0 })
        expect(store.get().theme).toBe('exported')
        expect(electron.open).not.toHaveBeenCalled()
        expect(electron.save).not.toHaveBeenCalled()
        expect(electron.send).toHaveBeenCalledWith('app:themesChanged', undefined)
        expect(electron.reload).toHaveBeenCalledOnce()
    })
})
