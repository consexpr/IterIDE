import { BUILTIN_THEMES } from './builtin'
import { DEFAULT_SHAPE, type IterTheme, type ThemeSource } from './types'
import { mergeComponents } from './components'
import { canonicalThemeId } from '../../shared/legacyBrand'

let themes: IterTheme[] = [...BUILTIN_THEMES]

/** Resolve one user theme against its base: `extends` id, else the first built-in of the same kind. */
export function resolveTheme(src: ThemeSource, pool: IterTheme[]): IterTheme {
    src = {
        ...src,
        ...(src.id === undefined ? {} : { id: canonicalThemeId(src.id) }),
        ...(src.extends === undefined ? {} : { extends: canonicalThemeId(src.extends) })
    }
    const base =
        pool.find((t) => t.id === src.extends) ?? pool.find((t) => t.kind === (src.kind ?? 'dark')) ?? BUILTIN_THEMES[0]
    const ownCss = src.css !== undefined || src.cssUrl !== undefined
    return {
        ...base,
        ...src,
        kind: src.kind ?? base.kind,
        ui: { ...base.ui, ...src.ui },
        verdict: { ...base.verdict, ...src.verdict },
        editor: { ...base.editor, ...src.editor },
        highlight: { ...base.highlight, ...src.highlight },
        tokens: { ...base.tokens, ...src.tokens },
        shape: { ...DEFAULT_SHAPE, ...base.shape, ...src.shape },
        components: mergeComponents(base.components, src.components),
        // CSS is not inherited unless asked for: a skin should start from a clean slate
        css: ownCss ? src.css : src.extends ? base.css : undefined,
        cssUrl: ownCss ? src.cssUrl : src.extends ? base.cssUrl : undefined
    }
}

/** Replace the user part of the registry. Invalid entries are skipped with a console warning. */
export function setUserThemes(raw: unknown[]): void {
    const sources = new Map<string, ThemeSource>()
    for (const t of raw) {
        const src = t as ThemeSource
        if (!src || typeof src.id !== 'string' || typeof src.name !== 'string') {
            console.warn('[iter] skipped theme without id/name', t)
            continue
        }
        const id = canonicalThemeId(src.id)
        sources.set(id, { ...src, id, extends: src.extends === undefined ? undefined : canonicalThemeId(src.extends) })
    }
    const resolved = new Map<string, IterTheme>()
    const resolving = new Set<string>()
    const resolve = (id: string): IterTheme | undefined => {
        if (resolved.has(id)) return resolved.get(id)
        const src = sources.get(id)
        // A missing/cyclic parent falls back to the built-in palette. Self-overrides of
        // built-in ids still inherit that original built-in, as in earlier releases.
        if (!src || resolving.has(id)) return undefined
        resolving.add(id)
        let parent = src.extends && src.extends !== id ? resolve(src.extends) : undefined
        if (!parent) {
            const fallback = BUILTIN_THEMES.find((t) => t.kind === (src.kind ?? 'dark')) ?? BUILTIN_THEMES[0]
            if (fallback.id !== id) parent = resolve(fallback.id)
        }
        const theme = resolveTheme(src, parent ? [parent, ...BUILTIN_THEMES] : BUILTIN_THEMES)
        resolving.delete(id)
        resolved.set(id, theme)
        return theme
    }
    const pool = [...BUILTIN_THEMES]
    for (const id of sources.keys()) {
        const theme = resolve(id)!
        const i = pool.findIndex((x) => x.id === id)
        if (i >= 0) pool[i] = theme
        else pool.push(theme)
    }
    themes = pool
}

export const allThemes = (): IterTheme[] => themes
export const findTheme = (id: string): IterTheme => themes.find((t) => t.id === canonicalThemeId(id)) ?? themes[0]
