import { expect, it } from 'vitest'
import { BUILTIN_THEMES } from './builtin'
import { contrast, parseColor, type Rgb } from './contrast'

// The requirements table in docs/THEMES.md §7, applied to every built-in theme.
const color = (value: string): Rgb => {
    const parsed = parseColor(value)
    if (!parsed) throw new Error(`Unparseable colour: ${value}`)
    return parsed
}

it.each(BUILTIN_THEMES.map((theme) => [theme.id, theme] as const))('%s meets the documented contrast', (_id, theme) => {
    const { editor, ui } = theme
    const background = color(editor.background)
    const selection = color(editor.selection)
    const tokens = Object.entries(theme.tokens).map(([name, spec]) => [name, color(spec.split(/\s+/)[0])] as const)
    const failures: string[] = []
    const need = (what: string, a: Rgb, b: Rgb, minimum: number): void => {
        const ratio = contrast(a, b)
        if (ratio < minimum) failures.push(`${what}: ${ratio.toFixed(2)} < ${minimum}`)
    }
    need('accent / background', color(ui.accent), background, 3)
    need('foreground / background', color(editor.foreground), background, 7)
    need('selection / background', selection, background, 1.4)
    need('foreground / selection', color(editor.foreground), selection, 4.5)
    need('lineHighlight / background', color(editor.lineHighlight), background, 1.03)
    for (const [name, rgb] of tokens) {
        need(`token ${name} / background`, rgb, background, name.startsWith('comment') ? 3 : 4.5)
        if (!name.startsWith('comment')) need(`token ${name} / selection`, rgb, selection, 3)
    }
    expect(failures).toEqual([])
})
