// Accelerator strings ("Ctrl+Shift+F5") ⇄ keyboard events ⇄ Monaco keybindings.
// Canonical order: Ctrl, Alt, Shift, then the key. `Ctrl` means Cmd on macOS.
import { monaco } from '../editor/monaco'

const MODS = ['Ctrl', 'Alt', 'Shift'] as const

/** Keys whose names differ between KeyboardEvent.key and how we display them. */
const KEY_ALIASES: Record<string, string> = {
    ' ': 'Space',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Esc: 'Escape'
}

/** Punctuation by physical key, so Shift doesn't change the name (Shift+/ is not "?"). */
const CODE_KEYS: Record<string, string> = {
    Slash: '/',
    Comma: ',',
    Period: '.',
    Semicolon: ';',
    Quote: "'",
    BracketLeft: '[',
    BracketRight: ']',
    Minus: '-',
    Equal: '=',
    Backquote: '`',
    Backslash: '\\'
}

/** Normalise an accelerator typed by a user or stored in settings. */
export function normalize(acc: string): string {
    const parts = acc
        .split('+')
        .map((p) => p.trim())
        .filter(Boolean)
    if (!parts.length) return ''
    const key = parts.pop()!
    const mods = MODS.filter((m) =>
        parts.some((p) => p.toLowerCase() === m.toLowerCase() || (m === 'Ctrl' && /^(cmd|meta|control)$/i.test(p)))
    )
    return [...mods, normKey(key)].join('+')
}

function normKey(k: string): string {
    const a = KEY_ALIASES[k] ?? k
    return a.length === 1 ? a.toUpperCase() : a[0].toUpperCase() + a.slice(1)
}

/** Accelerator for a keydown; null for a bare modifier press. */
export function fromEvent(e: KeyboardEvent): string | null {
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null
    // use the physical key for letters/digits so Shift+1 stays "Shift+1", not "!"
    const code = /^Key([A-Z])$/.exec(e.code)?.[1] ?? /^Digit(\d)$/.exec(e.code)?.[1] ?? CODE_KEYS[e.code]
    const key = code ?? normKey(e.key)
    const mods = [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : ''].filter(
        Boolean
    )
    return [...mods, key].join('+')
}

/** Accelerator → Monaco keybinding number, or null if the key isn't representable. */
export function toMonaco(acc: string): number | null {
    if (!acc) return null
    const parts = normalize(acc).split('+')
    const key = parts.pop()!
    const code = monacoKeyCode(key)
    if (code === null) return null
    let kb: number = code
    if (parts.includes('Ctrl')) kb |= monaco.KeyMod.CtrlCmd
    if (parts.includes('Alt')) kb |= monaco.KeyMod.Alt
    if (parts.includes('Shift')) kb |= monaco.KeyMod.Shift
    return kb
}

function monacoKeyCode(key: string): number | null {
    const K = monaco.KeyCode
    if (/^[A-Z]$/.test(key)) return K[`Key${key}` as keyof typeof K] as number
    if (/^\d$/.test(key)) return K[`Digit${key}` as keyof typeof K] as number
    if (/^F([1-9]|1[0-2])$/.test(key)) return K[key as keyof typeof K] as number
    const map: Record<string, number> = {
        Enter: K.Enter,
        Escape: K.Escape,
        Space: K.Space,
        Tab: K.Tab,
        Backspace: K.Backspace,
        Delete: K.Delete,
        Up: K.UpArrow,
        Down: K.DownArrow,
        Left: K.LeftArrow,
        Right: K.RightArrow,
        Home: K.Home,
        End: K.End,
        PageUp: K.PageUp,
        PageDown: K.PageDown,
        '/': K.Slash,
        ',': K.Comma,
        '.': K.Period,
        ';': K.Semicolon,
        "'": K.Quote,
        '[': K.BracketLeft,
        ']': K.BracketRight,
        '-': K.Minus,
        '=': K.Equal,
        '`': K.Backquote,
        '\\': K.Backslash
    }
    return map[key] ?? null
}

/** Display form: "Ctrl Shift F5". */
export const pretty = (acc: string): string => acc.split('+').join(' ')
