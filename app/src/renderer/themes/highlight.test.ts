import { expect, it } from 'vitest'
import { highlightColors } from './apply'
import { BUILTIN_THEMES } from './builtin'
import { blend, contrast, parseColor, type Rgb } from './contrast'

const rgb = (value: string): Rgb => parseColor(value)!
const alpha = (value: string): number => parseInt(value.slice(7, 9), 16) / 255

it.each(BUILTIN_THEMES.map((theme) => [theme.id, theme] as const))(
    '%s: highlights are fills that keep code readable',
    (_id, theme) => {
        const colors = highlightColors(theme)
        const background = rgb(theme.editor.background)
        const texts = [
            rgb(theme.editor.foreground),
            ...Object.entries(theme.tokens)
                .filter(([name]) => !name.startsWith('comment'))
                .map(([, spec]) => rgb(spec.split(/\s+/)[0]))
        ]
        for (const [key, fill] of Object.entries(colors).filter(
            ([key]) => key.endsWith('Background') && !key.includes('selectionBackground')
        )) {
            const surface = blend(background, rgb(fill), alpha(fill))
            for (const text of texts) expect(contrast(text, surface), `${key} under ${text}`).toBeGreaterThanOrEqual(3)
            // ...and visible: the filled surface must differ from the plain background
            expect(contrast(surface, background), `${key} / background`).toBeGreaterThanOrEqual(1.2)
        }
        // no outlines or underlines: borders are transparent
        for (const [key, value] of Object.entries(colors).filter(([key]) => key.endsWith('Border')))
            expect(alpha(value), key).toBe(0)
    }
)

it.each(BUILTIN_THEMES.map((theme) => [theme.id, theme] as const))(
    '%s: the selected word differs in colour from its other occurrences',
    (_id, theme) => {
        const background = rgb(theme.editor.background)
        const selected = rgb(theme.editor.selection)
        const occurrence = blend(background, rgb(theme.highlight.occurrence), alpha(theme.highlight.occurrence))
        const distance = Math.hypot(...selected.map((c, i) => c - occurrence[i]))
        expect(distance).toBeGreaterThan(14)
    }
)
