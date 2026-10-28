import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({
    app: { getPath: () => runtime.root, getAppPath: () => runtime.root, isPackaged: false }
}))

import { findTheme, setUserThemes } from '../renderer/themes/registry'
import { importConfig } from './configBundle/import'
import { writeZip } from './configBundle/zip'
import { SettingsStore } from './settings'
import { listThemes, themeAssetPath } from './themes'

let temp: string
function file(name: string, data: string | Buffer): void {
    const target = path.join(runtime.root, name)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, data)
}

beforeEach(() => {
    temp = mkdtempSync(path.join(os.tmpdir(), 'iter-theme-compat-'))
    runtime.root = path.join(temp, 'profile')
    mkdirSync(runtime.root)
})
afterEach(() => {
    setUserThemes([])
    const target = path.resolve(temp)
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('iter-theme-compat-'))
        throw new Error('Refusing to remove a directory outside this theme test temporary root')
    rmSync(temp, { recursive: true, force: true })
})

describe('0.1.0 theme files', () => {
    it('loads single JSON themes, inline CSS and directory themes without rewriting their files', () => {
        const inline = JSON.stringify({ id: 'inline', name: 'Inline', css: '.nv-test { border-radius: 0; }' })
        const packaged = JSON.stringify({ id: 'package', name: '包主题', shape: { islandRadius: '2px' } })
        file('themes/inline.json', inline)
        file('themes/旧主题/theme.json', packaged)
        file('themes/旧主题/theme.css', '.nv-center { background: url("背景.png"); }')
        file('themes/旧主题/背景.png', Buffer.from([0, 255, 13, 10]))
        const dir = path.join(runtime.root, 'themes')
        setUserThemes(listThemes(dir))
        expect(findTheme('inline').css).toBe('.nv-test { border-radius: 0; }')
        expect(findTheme('package').shape.islandRadius).toBe('2px')
        const stylesheet = new URL(findTheme('package').cssUrl!)
        expect(readFileSync(themeAssetPath(dir, stylesheet.pathname)!, 'utf8')).toContain('背景.png')
        const image = new URL('背景.png', stylesheet)
        expect(readFileSync(themeAssetPath(dir, image.pathname)!)).toEqual(Buffer.from([0, 255, 13, 10]))
        expect(readFileSync(path.join(dir, 'inline.json'), 'utf8')).toBe(inline)
        expect(readFileSync(path.join(dir, '旧主题/theme.json'), 'utf8')).toBe(packaged)
    })

    it('keeps the existing cssFile package layout', () => {
        file('themes/custom/theme.json', JSON.stringify({ id: 'custom', name: 'Custom', cssFile: 'styles/skin.css' }))
        file('themes/custom/styles/skin.css', '.nvi { --island-fg: var(--accent); }')
        setUserThemes(listThemes(path.join(runtime.root, 'themes')))
        expect(findTheme('custom').cssUrl).toBe('iter://themes/custom/styles/skin.css')
    })

    it.each([1, 2])(
        'imports old theme selection, CSS, font assets and tokens from a v%i configuration bundle',
        async (version) => {
            const store = new SettingsStore()
            const theme = JSON.stringify({
                id: 'legacy',
                name: 'Legacy 0.1.0',
                extends: 'iter-paper',
                ui: { accent: '#123456' },
                tokens: { function: '#345678 bold' },
                shape: { radius: '13px' }
            })
            const css = '@font-face { font-family: Legacy; src: url("Legacy.woff2"); } .nv-app { font-family: Legacy; }'
            const font = Buffer.from([0, 255, 13, 10])
            const archive = path.join(temp, 'old.iterconf')
            await writeZip(archive, [
                {
                    name: 'manifest.json',
                    data: Buffer.from(
                        JSON.stringify({
                            format: 'iter-config',
                            version,
                            appVersion: '0.1.0',
                            createdAt: '2026-10-19T00:00:00Z',
                            contents: ['settings.json', 'themes/', 'fonts/', ...(version === 1 ? ['plugins/'] : [])]
                        })
                    )
                },
                {
                    name: 'settings.json',
                    data: Buffer.from(JSON.stringify({ theme: 'legacy', editor: { fontFamily: 'Legacy' } }))
                },
                ...['themes/', 'fonts/', 'themes/legacy/'].map((name) => ({ name, data: Buffer.alloc(0) })),
                { name: 'themes/legacy/theme.json', data: Buffer.from(theme) },
                { name: 'themes/legacy/theme.css', data: Buffer.from(css) },
                { name: 'themes/legacy/Legacy.woff2', data: font },
                { name: 'fonts/Legacy.woff2', data: font }
            ])
            await importConfig(archive, store)
            setUserThemes(store.listUserThemes())
            expect(store.get()).toMatchObject({ theme: 'legacy', editor: { fontFamily: 'Legacy' } })
            expect(findTheme(store.get().theme)).toMatchObject({
                kind: 'light',
                ui: { accent: '#123456' },
                tokens: { function: '#345678 bold' },
                shape: { radius: '13px' },
                cssUrl: 'iter://themes/legacy/theme.css'
            })
            expect(store.listUserFonts()).toContainEqual({ family: 'Legacy', file: 'Legacy.woff2' })
            expect(readFileSync(path.join(runtime.root, 'themes/legacy/theme.json'), 'utf8')).toBe(theme)
            expect(readFileSync(path.join(runtime.root, 'themes/legacy/theme.css'), 'utf8')).toBe(css)
            expect(readFileSync(path.join(runtime.root, 'themes/legacy/Legacy.woff2'))).toEqual(font)
        }
    )
})
