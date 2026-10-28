import { expect, it } from 'vitest'
import { applyComponentTokens } from './components'
import { findTheme, setUserThemes } from './registry'

it('inherits each component field and resets component overrides when switching to a legacy theme', () => {
    try {
        setUserThemes([
            {
                id: 'glass',
                name: 'Glass',
                components: {
                    brand: { color: '#527aff', motionDuration: '300ms' },
                    search: { background: '#11223380', openDuration: '310ms' },
                    checker: { argumentBackground: 'transparent' }
                }
            },
            {
                id: 'glass-child',
                name: 'Child',
                extends: 'glass',
                components: { search: { width: '480px' }, snapshots: { rowHeight: '28px' } }
            }
        ])
        const theme = findTheme('glass-child')
        expect(theme.components).toMatchObject({
            brand: { color: '#527aff', motionDuration: '300ms' },
            search: { background: '#11223380', openDuration: '310ms', width: '480px' },
            checker: { argumentBackground: 'transparent' },
            snapshots: { rowHeight: '28px' }
        })
        const values = new Map<string, string>()
        const style = {
            setProperty: (key: string, value: string) => {
                values.set(key, value)
            },
            removeProperty: (key: string) => {
                const old = values.get(key)
                values.delete(key)
                return old ?? ''
            }
        }
        applyComponentTokens(style, theme.components)
        expect(values.get('--search-background')).toBe('#11223380')
        expect(values.get('--brand-color')).toBe('#527aff')
        expect(values.get('--snapshots-row-height')).toBe('28px')
        applyComponentTokens(style, findTheme('iter-dusk').components)
        expect(values.size).toBe(0)
    } finally {
        setUserThemes([])
    }
})
