import { afterEach, describe, expect, it } from 'vitest'
import { BUILTIN_THEMES } from './builtin'
import { allThemes, findTheme, setUserThemes } from './registry'

afterEach(() => setUserThemes([]))

describe('legacy theme compatibility', () => {
    it('keeps renamed built-in selections, overrides and inherited palettes', () => {
        setUserThemes([
            { id: 'naven-paper', name: 'Personal paper', extends: 'naven-paper', ui: { accent: '#123456' } },
            { id: 'old-child', name: 'Child', extends: 'naven-paper' }
        ])
        expect(findTheme('naven-paper')).toBe(findTheme('iter-paper'))
        expect(findTheme('old-child')).toMatchObject({ kind: 'light', ui: { accent: '#123456' } })
        expect(allThemes().some((theme) => theme.id.startsWith('naven-'))).toBe(false)
    })

    it('fills omitted tokens and shape fields in a minimal 0.1.0 JSON theme', () => {
        setUserThemes([{ id: 'legacy', name: '旧主题' }])
        const theme = findTheme('legacy')
        const base = BUILTIN_THEMES[0]
        expect(theme).toMatchObject({ id: 'legacy', name: '旧主题', kind: 'dark' })
        expect(theme.ui).toEqual(base.ui)
        expect(theme.editor).toEqual(base.editor)
        expect(theme.verdict).toEqual(base.verdict)
        expect(theme.tokens).toEqual(base.tokens)
        expect(theme.shape).toEqual(base.shape)
    })

    it('preserves partial colors, shape, syntax rules and inline CSS without requiring new fields', () => {
        const css = '.nv-app { font-family: Legacy; } .nvi { --island-bg: var(--panel); }'
        setUserThemes([
            {
                id: 'legacy-light',
                name: '旧浅色',
                kind: 'light',
                ui: { accent: '#123456' },
                editor: { foreground: '#234567' },
                verdict: { ac: '#345678' },
                tokens: { comment: '#456789 italic' },
                shape: { radius: '12px', islandRadius: '0px' },
                css
            }
        ])
        const theme = findTheme('legacy-light')
        const base = BUILTIN_THEMES.find((t) => t.kind === 'light')!
        expect(theme.ui).toEqual({ ...base.ui, accent: '#123456' })
        expect(theme.editor).toEqual({ ...base.editor, foreground: '#234567' })
        expect(theme.verdict).toEqual({ ...base.verdict, ac: '#345678' })
        expect(theme.tokens).toEqual({ ...base.tokens, comment: '#456789 italic' })
        expect(theme.shape).toEqual({ ...base.shape, radius: '12px', islandRadius: '0px' })
        expect(theme.css).toBe(css)
    })

    it('resolves user inheritance chains regardless of discovery order', () => {
        setUserThemes([
            { id: 'child', name: 'Child', extends: 'parent', ui: { accent: '#123456' } },
            { id: 'parent', name: 'Parent', extends: 'grandparent', shape: { radius: '15px' } },
            {
                id: 'grandparent',
                name: 'Grandparent',
                kind: 'light',
                editor: { background: '#eeeeee' },
                tokens: { keyword: '#654321 bold' }
            }
        ])
        expect(findTheme('child')).toMatchObject({
            kind: 'light',
            ui: { accent: '#123456' },
            shape: { radius: '15px' },
            editor: { background: '#eeeeee' },
            tokens: { keyword: '#654321 bold' }
        })
        expect(
            allThemes()
                .slice(BUILTIN_THEMES.length)
                .map((t) => t.id)
        ).toEqual(['child', 'parent', 'grandparent'])
    })

    it('inherits package CSS through extends, including relative asset origin', () => {
        const cssUrl = 'iter://themes/legacy/theme.css'
        setUserThemes([
            { id: 'legacy', name: 'Legacy', cssUrl },
            { id: 'child', name: 'Child', extends: 'legacy' }
        ])
        expect(findTheme('child').cssUrl).toBe(cssUrl)
    })

    it('uses the child inline stylesheet instead of the parent package stylesheet', () => {
        setUserThemes([
            { id: 'parent', name: 'Parent', cssUrl: 'iter://themes/parent/theme.css' },
            { id: 'child', name: 'Child', extends: 'parent', css: '.nvi { border-radius: 0; }' }
        ])
        expect(findTheme('child')).toMatchObject({ css: '.nvi { border-radius: 0; }' })
        expect(findTheme('child').cssUrl).toBeUndefined()
    })

    it('uses the child package stylesheet instead of the parent inline stylesheet', () => {
        setUserThemes([
            { id: 'parent', name: 'Parent', css: '.nv-app { color: red; }' },
            { id: 'child', name: 'Child', extends: 'parent', cssUrl: 'iter://themes/child/skin.css' }
        ])
        expect(findTheme('child').cssUrl).toBe('iter://themes/child/skin.css')
        expect(findTheme('child').css).toBeUndefined()
    })

    it('allows an explicit empty stylesheet to disable inherited CSS', () => {
        setUserThemes([
            { id: 'parent', name: 'Parent', cssUrl: 'iter://themes/parent/theme.css' },
            { id: 'child', name: 'Child', extends: 'parent', css: '' }
        ])
        expect(findTheme('child').css).toBe('')
        expect(findTheme('child').cssUrl).toBeUndefined()
    })

    it('falls back to a complete built-in when an inherited theme is missing', () => {
        setUserThemes([{ id: 'orphan', name: 'Orphan', kind: 'light', extends: 'absent', ui: { accent: '#123456' } }])
        const base = BUILTIN_THEMES.find((t) => t.kind === 'light')!
        expect(findTheme('orphan').ui).toEqual({ ...base.ui, accent: '#123456' })
        expect(findTheme('orphan').shape).toEqual(base.shape)
    })

    it('bounds cyclic inheritance and still produces usable themes', () => {
        setUserThemes([
            { id: 'a', name: 'A', extends: 'b', ui: { accent: '#123456' } },
            { id: 'b', name: 'B', extends: 'a', shape: { radius: '9px' } },
            { id: 'self', name: 'Self', extends: 'self' }
        ])
        expect(findTheme('a').ui.accent).toBe('#123456')
        expect(findTheme('b').shape.radius).toBe('9px')
        for (const id of ['a', 'b', 'self']) {
            expect(findTheme(id).editor.background).toBeTruthy()
            expect(findTheme(id).ui.text).toBeTruthy()
        }
    })

    it('retains built-in customization and removes deleted user themes on reload', () => {
        setUserThemes([
            { id: 'iter-dusk', name: 'Personal dusk', extends: 'iter-dusk', ui: { accent: '#123456' } },
            { id: 'temporary', name: 'Temporary' }
        ])
        expect(findTheme('iter-dusk').ui.accent).toBe('#123456')
        expect(allThemes().filter((t) => t.id === 'iter-dusk')).toHaveLength(1)
        setUserThemes([])
        expect(allThemes()).toEqual(BUILTIN_THEMES)
    })

    it('retains customized built-in fallbacks for existing themes without extends', () => {
        setUserThemes([
            { id: 'iter-dusk', name: 'Personal dusk', ui: { accent: '#123456' } },
            { id: 'minimal', name: 'Minimal' },
            { id: 'orphan', name: 'Orphan', extends: 'absent' }
        ])
        expect(findTheme('minimal').ui.accent).toBe('#123456')
        expect(findTheme('orphan').ui.accent).toBe('#123456')
    })
})
