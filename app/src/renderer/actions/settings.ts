import type { AppSettings } from '../../shared/settings'
import { monaco } from '../editor/monaco'
import { applyModelIndentation } from '../editor/indentation'
import { editorRef } from '../editor/instance'
import { indentationSettings } from '../../shared/indentation'
import { applyTheme, findTheme, setUserThemes } from '../themes/apply'
import { store, toast } from '../state/app'

const api = window.iter

type Patch = { [K in keyof AppSettings]?: AppSettings[K] extends object ? Partial<AppSettings[K]> : AppSettings[K] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Same deep merge the main process applies, so the optimistic copy matches what gets saved. */
function merge<T>(base: T, patch: unknown): T {
    if (!isObj(base) || !isObj(patch)) return (patch === undefined ? base : patch) as T
    const out: Record<string, unknown> = { ...base }
    for (const [k, v] of Object.entries(patch)) out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : v
    return out as T
}

/**
 * Optimistic: the UI updates immediately and the main process saves in the background. Waiting for
 * the round trip made controlled inputs snap back to the old value (caret jumping to the end).
 */
export async function updateSettings(patch: Patch): Promise<void> {
    const prev = store.get().settings
    const settings = merge(prev, patch)
    store.set({ settings })
    const before = indentationSettings(prev.editor),
        after = indentationSettings(settings.editor)
    if (before.tabSize !== after.tabSize || before.insertSpaces !== after.insertSpaces) {
        for (const file of store.get().files) applyModelIndentation(file.model, settings.editor, true, editorRef.editor)
    }
    if (settings.theme !== prev.theme) applyTheme(monaco, findTheme(settings.theme))
    if (settings.uiFontFamily !== prev.uiFontFamily || settings.uiFontSize !== prev.uiFontSize)
        applyUiFont(settings.uiFontFamily, settings.uiFontSize)
    try {
        await api.settings.set(patch as Partial<AppSettings>)
    } catch (e) {
        toast(`设置保存失败：${(e as Error).message}`, 'error')
    }
}

export function applyUiFont(family: string, size?: number): void {
    document.documentElement.style.setProperty('--ui-font', family)
    if (size) document.documentElement.style.setProperty('--ui-font-size', `${size}px`)
}

/** Load settings, user themes and user fonts, then paint. */
export async function loadAppearance(): Promise<AppSettings> {
    const [settings, userThemes, userFonts] = await Promise.all([
        api.settings.get(),
        api.settings.listUserThemes().catch(() => []),
        api.settings.listUserFonts().catch(() => [])
    ])
    setUserThemes(userThemes)
    api.settings.onThemesChanged(() => void reloadThemes())
    if (userFonts.length) {
        const css = userFonts
            .map(
                (f) =>
                    `@font-face{font-family:"${f.family}";src:url("iter://fonts/${encodeURIComponent(f.file)}");font-display:swap}`
            )
            .join('\n')
        const style = document.createElement('style')
        style.textContent = css
        document.head.appendChild(style)
    }
    applyTheme(monaco, findTheme(settings.theme))
    applyUiFont(settings.uiFontFamily, settings.uiFontSize)
    store.set({ settings })
    return settings
}

/** Re-read user themes from disk and repaint the current one. */
export async function reloadThemes(): Promise<void> {
    setUserThemes(await api.settings.listUserThemes().catch(() => []))
    applyTheme(monaco, findTheme(store.get().settings.theme))
    store.set((s) => ({ themeVersion: s.themeVersion + 1 }))
}

/** Export settings/themes/fonts/plugins (never code or problem data) to a .iterconf file. */
export async function exportConfig(): Promise<void> {
    const file = await api.config.export().catch((e: Error) => {
        toast(`导出失败：${e.message}`, 'error', 6000)
        return null
    })
    if (file) toast(`已导出到 ${file}`, 'success', 5000)
}

export async function importConfig(): Promise<void> {
    const r = await api.config.import().catch((e: Error) => {
        toast(`导入失败：${e.message}`, 'error', 6000)
        return null
    })
    if (!r) return
    const settings = await api.settings.get()
    store.set({ settings })
    applyUiFont(settings.uiFontFamily, settings.uiFontSize)
    await reloadThemes()
    toast(`已导入：主题 ${r.themes} · 字体 ${r.fonts} · 插件 ${r.plugins}`, 'success', 5000)
}
