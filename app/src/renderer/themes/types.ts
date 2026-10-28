// Theme = skin. The app (logic, layout, data) never changes; a theme only restyles it through
// the contract documented in docs/THEMES.md:
//   1. tokens below → CSS variables (+ Monaco editor theme)
//   2. optional CSS that targets the stable `nv-*` classes and `data-*` state attributes
// Built-in themes and user theme packages use exactly the same format.
import type { ThemeComponents } from './components'

export interface ThemeShape {
    radiusSm: string // small controls (buttons, inputs)
    radius: string // cards
    radiusLg: string // dialogs, tiles
    islandRadius: string // dynamic island
}

export interface IterTheme {
    id: string
    name: string
    kind: 'dark' | 'light'
    ui: {
        bg: string // window background (behind panels)
        panel: string // side panel, title bar, status bar
        elevated: string // cards, popovers, dialogs
        sunken: string // inputs, IO boxes
        border: string
        borderStrong: string
        text: string
        textMuted: string
        textFaint: string
        accent: string
        accentText: string // text drawn on top of accent
        hover: string // translucent overlay for hover states
        selection: string
        shadow: string // CSS box-shadow for floating surfaces
    }
    verdict: {
        ac: string
        wa: string
        tle: string
        mle: string
        re: string
        ce: string
        pending: string
    }
    editor: {
        background: string
        foreground: string
        lineHighlight: string
        selection: string
        cursor: string
        lineNumber: string
        lineNumberActive: string
        indentGuide: string
        bracketMatch: string
        debugLine: string // background of the paused line
    }
    /**
     * Highlight fills, chosen by the theme (never derived by the app). Fills only: no borders or underlines.
     * The selected word uses `editor.selection`; the other occurrences use these, in a different colour.
     * `#rrggbbaa` lays over the editor background, so keep text readable (docs/THEMES.md §7).
     */
    highlight: {
        occurrence: string // other occurrences of the word under the caret
        occurrenceWrite: string // occurrences that are written to
        selectionMatch: string // other copies of the selected text
        findCurrent: string // the active search match
        findOther: string // the remaining search matches
        findRange: string // the range a search is limited to
    }
    /** Monaco token colors; keys are token types (prefix match), values `#rrggbb` or `#rrggbb italic|bold`. */
    tokens: Record<string, string>
    shape: ThemeShape
    components?: ThemeComponents
    /** Extra CSS (built-ins inline it; packages point to a file, resolved to `cssUrl` by the loader). */
    css?: string
    cssUrl?: string
}

/** What a user theme file may contain: everything optional except id/name; `extends` picks the base. */
export type ThemeSource = Partial<Omit<IterTheme, 'ui' | 'verdict' | 'editor' | 'highlight' | 'shape'>> & {
    id: string
    name: string
    extends?: string
    ui?: Partial<IterTheme['ui']>
    verdict?: Partial<IterTheme['verdict']>
    editor?: Partial<IterTheme['editor']>
    highlight?: Partial<IterTheme['highlight']>
    shape?: Partial<ThemeShape>
}

export const DEFAULT_SHAPE: ThemeShape = { radiusSm: '5px', radius: '7px', radiusLg: '11px', islandRadius: '999px' }
