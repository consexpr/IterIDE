import type * as Monaco from 'monaco-editor/editor/editor.api'
import type { IterTheme } from './types'
import { applyComponentTokens } from './components'

export { allThemes, findTheme, setUserThemes } from './registry'

const kebab = (s: string): string => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())

/** A bare `0` is not a valid length inside min()/calc(), so give plain numbers a unit. */
const cssLength = (value: string): string => (/^-?\d+(\.\d+)?$/.test(value.trim()) ? `${value.trim()}px` : value)

/** Paint a theme: CSS variables, root attributes, theme CSS, Monaco colors. */
export function applyTheme(monaco: typeof Monaco, theme: IterTheme): void {
    const root = document.documentElement
    applyComponentTokens(root.style, theme.components)
    for (const [k, v] of Object.entries(theme.ui)) root.style.setProperty(`--${kebab(k)}`, v)
    for (const [k, v] of Object.entries(theme.verdict)) root.style.setProperty(`--v-${k}`, v)
    for (const [k, v] of Object.entries(theme.editor)) root.style.setProperty(`--editor-${kebab(k)}`, v)
    root.style.setProperty('--r-sm', cssLength(theme.shape.radiusSm))
    root.style.setProperty('--r', cssLength(theme.shape.radius))
    root.style.setProperty('--r-lg', cssLength(theme.shape.radiusLg))
    root.style.setProperty('--r-island', cssLength(theme.shape.islandRadius))
    root.dataset.kind = theme.kind
    root.dataset.theme = theme.id
    applyThemeCss(theme)
    const data = monacoTheme(theme)
    monaco.editor.defineTheme(theme.id, data)
    monaco.editor.setTheme(theme.id)
    // Monaco scopes its --vscode-* colour variables to the editor element, but overlays such as the
    // context menu are mounted outside it (in a shadow root under <body>) and would fall back to
    // transparent. Mirroring the variables on :root lets every overlay inherit them.
    for (const [key, value] of Object.entries(data.colors))
        root.style.setProperty(`--vscode-${key.replace(/\./g, '-')}`, value)
}

function applyThemeCss(theme: IterTheme): void {
    document.getElementById('nv-theme-css')?.remove()
    if (theme.cssUrl) {
        const link = document.createElement('link')
        link.id = 'nv-theme-css'
        link.rel = 'stylesheet'
        // cache-bust so edits show up on live reload
        link.href = `${theme.cssUrl}?v=${Date.now()}`
        document.head.appendChild(link)
    } else if (theme.css) {
        const style = document.createElement('style')
        style.id = 'nv-theme-css'
        style.textContent = theme.css
        document.head.appendChild(style)
    }
}

const CLEAR = '#00000000'

/**
 * Highlights come straight from the theme: fills only, never borders or underlines. The selected word
 * (`editor.selection`) and its other occurrences differ by colour, not by outline.
 */
export function highlightColors(theme: IterTheme): Record<string, string> {
    const h = theme.highlight
    return {
        'editor.selectionBackground': theme.editor.selection,
        'editor.wordHighlightBackground': h.occurrence,
        'editor.wordHighlightStrongBackground': h.occurrenceWrite,
        'editor.wordHighlightTextBackground': h.occurrence,
        'editor.selectionHighlightBackground': h.selectionMatch,
        'editor.findMatchBackground': h.findCurrent,
        'editor.findMatchHighlightBackground': h.findOther,
        'editor.findRangeHighlightBackground': h.findRange,
        'editor.wordHighlightBorder': CLEAR,
        'editor.wordHighlightStrongBorder': CLEAR,
        'editor.wordHighlightTextBorder': CLEAR,
        'editor.selectionHighlightBorder': CLEAR,
        'editor.findMatchBorder': CLEAR,
        'editor.findMatchHighlightBorder': CLEAR,
        'editor.findRangeHighlightBorder': CLEAR
    }
}

function monacoTheme(theme: IterTheme): Monaco.editor.IStandaloneThemeData {
    const rules: Monaco.editor.ITokenThemeRule[] = Object.entries(theme.tokens).map(([token, spec]) => {
        const [color, ...styles] = spec.split(/\s+/)
        return { token, foreground: color.replace('#', ''), fontStyle: styles.join(' ') || undefined }
    })
    const e = theme.editor
    const u = theme.ui
    const dark = theme.kind === 'dark'
    return {
        base: dark ? 'vs-dark' : 'vs',
        inherit: true,
        rules,
        colors: {
            'editor.background': e.background,
            'editor.foreground': e.foreground,
            'editor.lineHighlightBackground': e.lineHighlight,
            'editor.lineHighlightBorder': '#00000000',
            'editor.selectionBackground': e.selection,
            'editor.inactiveSelectionBackground': e.selection + '99',
            ...highlightColors(theme),
            'editorCursor.foreground': e.cursor,
            'editorLineNumber.foreground': e.lineNumber,
            'editorLineNumber.activeForeground': e.lineNumberActive,
            'editorIndentGuide.background1': e.indentGuide,
            'editorIndentGuide.activeBackground1': e.lineNumber,
            'editorBracketMatch.background': e.bracketMatch,
            'editorBracketMatch.border': '#00000000',
            'editorGutter.background': e.background,
            'editorWidget.background': u.elevated,
            'editorWidget.border': u.borderStrong,
            'editorSuggestWidget.background': u.elevated,
            'editorSuggestWidget.border': u.borderStrong,
            'editorSuggestWidget.selectedBackground': u.selection,
            'editorSuggestWidget.highlightForeground': u.accent,
            'editorSuggestWidget.focusHighlightForeground': u.accent,
            'editorHoverWidget.background': u.elevated,
            'editorHoverWidget.border': u.borderStrong,
            'editorError.foreground': theme.verdict.wa,
            'editorWarning.foreground': theme.verdict.tle,
            'editorInfo.foreground': u.accent,
            'scrollbarSlider.background': dark ? '#ffffff14' : '#0000001a',
            'scrollbarSlider.hoverBackground': dark ? '#ffffff22' : '#0000002a',
            'scrollbarSlider.activeBackground': dark ? '#ffffff30' : '#00000038',
            'editorOverviewRuler.border': '#00000000',
            'minimap.background': e.background,
            focusBorder: '#00000000',
            'input.background': u.sunken,
            'input.border': u.border,
            'list.hoverBackground': u.hover,
            'list.activeSelectionBackground': u.selection,
            'list.focusBackground': u.selection,
            // every Monaco overlay must be themed explicitly, or it falls back to unreadable defaults
            foreground: u.text,
            descriptionForeground: u.textMuted,
            'widget.shadow': dark ? '#00000080' : '#00000026',
            'menu.background': u.elevated,
            'menu.foreground': u.text,
            'menu.border': u.borderStrong,
            'menu.selectionBackground': u.selection,
            'menu.selectionForeground': u.text,
            'menu.selectionBorder': '#00000000',
            'menu.separatorBackground': u.border,
            'quickInput.background': u.elevated,
            'quickInput.foreground': u.text,
            'quickInputTitle.background': u.panel,
            'pickerGroup.foreground': u.accent,
            'pickerGroup.border': u.border,
            'input.foreground': u.text,
            'input.placeholderForeground': u.textFaint,
            'list.activeSelectionForeground': u.text,
            'list.inactiveSelectionBackground': u.hover,
            'list.inactiveSelectionForeground': u.text,
            'list.hoverForeground': u.text,
            'list.highlightForeground': u.accent,
            'list.focusForeground': u.text,
            'keybindingLabel.background': u.sunken,
            'keybindingLabel.foreground': u.textMuted,
            'keybindingLabel.border': u.border,
            'keybindingLabel.bottomBorder': u.borderStrong,
            'editorSuggestWidget.foreground': u.text,
            'editorSuggestWidget.selectedForeground': u.text,
            'editorHoverWidget.foreground': u.text,
            'editorWidget.foreground': u.text,
            'peekView.border': u.accent,
            'peekViewTitle.background': u.panel,
            'peekViewResult.background': u.elevated,
            'peekViewEditor.background': e.background
        }
    }
}
