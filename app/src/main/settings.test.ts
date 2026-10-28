import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({ app: { getPath: () => runtime.root } }))
import { SettingsStore } from './settings'

beforeEach(() => {
    runtime.root = mkdtempSync(path.join(os.tmpdir(), 'iter-settings-'))
})
afterEach(() => {
    rmSync(runtime.root, { recursive: true, force: true })
})
const file = () => path.join(runtime.root, 'settings.json')

it('deep-merges updates, persists complete JSON and reloads the same settings', () => {
    const settings = new SettingsStore()
    const originalSize = settings.get().editor.fontSize
    settings.set({ theme: 'iter-paper' })
    expect(new SettingsStore().get()).toEqual(settings.get())
    expect(settings.get().editor.fontSize).toBe(originalSize)
    expect(readdirSync(runtime.root).some((name) => name.endsWith('.tmp'))).toBe(false)
})

it('retains live settings and the previous JSON when atomic replacement fails', () => {
    const settings = new SettingsStore()
    settings.set({ theme: 'iter-paper' })
    const original = settings.get(),
        bytes = readFileSync(file())
    renameSync(file(), file() + '.before')
    mkdirSync(file()) // A directory cannot be replaced by a settings file, on every supported platform.
    expect(() => settings.set({ theme: 'iter-dusk' })).toThrow()
    expect(settings.get()).toBe(original)
    expect(readFileSync(file() + '.before')).toEqual(bytes)
    expect(readdirSync(runtime.root).some((name) => name.endsWith('.tmp'))).toBe(false)
    expect(() => settings.replaceConfig({ theme: 'iter-dusk' })).toThrow()
    expect(settings.get()).toBe(original)
})

it.each(['null', '[]', 'true', '42', '"settings"', '{broken'])('survives a malformed settings root: %s', (text) => {
    writeFileSync(file(), text)
    expect(new SettingsStore().get().editor.fontSize).toBeGreaterThan(0)
    expect(readFileSync(file(), 'utf8')).toBe(text)
})

it('ignores prototype keys recursively while retaining ordinary plugin configuration', () => {
    const settings = new SettingsStore()
    settings.set(
        JSON.parse(
            '{"__proto__":{"polluted":true},"pluginEnabled":{"notes":false,"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}}'
        )
    )
    expect(settings.get().pluginEnabled).toEqual({ notes: false })
    expect((settings.get() as any).polluted).toBeUndefined()
    expect(({} as any).polluted).toBeUndefined()
    expect(readFileSync(file(), 'utf8')).not.toMatch(/__proto__|polluted|constructor/)
})

it('recovers damaged nested fields without losing valid siblings or overwriting the original', () => {
    const original = JSON.stringify({
        theme: 'custom',
        editor: { fontSize: -2, completion: { snippets: {} } },
        toolchain: null
    })
    writeFileSync(file(), original)
    const settings = new SettingsStore()
    expect(settings.get().theme).toBe('custom')
    expect(settings.get().editor.fontSize).toBeGreaterThan(0)
    expect(settings.get().editor.completion.snippets).toEqual([])
    expect(settings.get().toolchain.compiler).toBe('g++')
    expect(readFileSync(file(), 'utf8')).toBe(original)
    settings.set({ autoSave: false })
    const backup = readdirSync(runtime.root).find((name) => name.startsWith('settings.json.corrupt-'))!
    expect(readFileSync(path.join(runtime.root, backup), 'utf8')).toBe(original)
    expect(new SettingsStore().get().autoSave).toBe(false)
})

it.each([
    { editor: null },
    { editor: { completion: { snippets: {} } } },
    { editor: { completion: { snippets: [{ trigger: 42, body: 'x' }] } } },
    { keybindings: { save: 42 } },
    { pluginEnabled: { notes: 'yes' } },
    { toolchain: { parallel: 0 } },
    { sync: { intervalMin: -1 } }
])('rejects malformed updates before changing live or stored settings: %j', (patch) => {
    const settings = new SettingsStore()
    settings.set({ theme: 'original' })
    const before = readFileSync(file())
    expect(() => settings.set(patch as never)).toThrow(/settings field/)
    expect(settings.get().theme).toBe('original')
    expect(readFileSync(file())).toEqual(before)
})
