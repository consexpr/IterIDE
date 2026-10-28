import type { ToolchainSettings } from './judge'
import { DEFAULT_CLANG_FORMAT_STYLE } from './format'
import { BUILTIN_GITHUB_CLIENT_ID, type SyncSettings } from './sync'
import { DEFAULT_AI_COMPLETION, type AiCompletionSettings } from './inlineAi'
import { canonicalThemeId } from './legacyBrand'

/** Completion behaviour, modelled on Red Panda C++'s options (clangd provides the symbols). */
export interface CompletionSettings {
    /** Local Model reranking of clangd candidates; disabled until explicitly enabled. */
    model?: boolean
    /** Inline (ghost text) completion from DeepSeek; Tab accepts. */
    ai?: AiCompletionSettings
    showCompletionWhileInput: boolean
    /** Enter also accepts the selected suggestion (Tab always does). */
    acceptOnEnter: boolean
    minCharRequired: number
    sortByScope: boolean
    recordUsage: boolean
    showKeywords: boolean
    ignoreCase: boolean
    appendFunc: boolean
    hideSymbolsStartsWithUnderLine: boolean
    hideSymbolsStartsWithTwoUnderLine: boolean
    /** User snippets: typing the trigger offers `body` (Monaco snippet syntax, unique placeholders). */
    snippets: { trigger: string; body: string; detail?: string }[]
}

export interface EditorSettings {
    fontFamily: string
    fontSize: number
    lineHeight: number // multiplier, e.g. 1.5
    /** Extra space between characters, px. */
    letterSpacing: number
    /** CSS font weight, 100–900. */
    fontWeight: number
    ligatures: boolean
    tabSize: number
    insertSpaces: boolean
    wordWrap: boolean
    minimap: boolean
    minimapScale: number
    /** clangd-backed completion; local CP completion always works. */
    semanticCompletion: boolean
    /** Live diagnostics while typing. */
    liveDiagnostics: boolean
    formatOnSave: boolean
    /** Legacy non-indentation format preferences; indentation always follows editor settings. */
    clangFormatStyle: string
    completion: CompletionSettings
    vim: boolean
}

export interface TerminalSettings {
    /** Three #rrggbb stops of the title and spinner sweep, cycled in order. */
    colors: string[]
}

export const DEFAULT_TERMINAL_COLORS = ['#a855f7', '#f472b6', '#ffffff']

/** Always three valid stops: anything malformed falls back to the default for that slot. */
export function terminalColors(colors: unknown): string[] {
    const list = Array.isArray(colors) ? colors : []
    return DEFAULT_TERMINAL_COLORS.map((fallback, i) =>
        typeof list[i] === 'string' && /^#[0-9a-f]{6}$/i.test(list[i]) ? list[i].toLowerCase() : fallback
    )
}

export interface AppSettings {
    theme: string // theme id
    uiFontFamily: string
    /** Base UI text size, px. */
    uiFontSize: number
    editor: EditorSettings
    toolchain: ToolchainSettings
    terminal: TerminalSettings
    /** Source template for new files. `$0` marks the cursor. */
    template: string
    recentFiles: string[]
    /** Shortcut overrides: command id → accelerator like `Ctrl+Shift+F5`; `""` = unbound, `null` = default. */
    keybindings: Record<string, string | null>
    /** Plugin id → enabled override. Missing ids are enabled; plugin code stays local. */
    pluginEnabled: Record<string, boolean>
    sync: SyncSettings
    autoSave: boolean
}

export const DEFAULT_TEMPLATE = `#include <bits/stdc++.h>
using namespace std;
using ll = long long;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);
    $0
    return 0;
}
`

export function defaultSettings(): AppSettings {
    return {
        theme: 'iter-dusk',
        uiFontSize: 13,
        uiFontFamily:
            '"Segoe UI Variable Text", "Segoe UI", "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei UI", system-ui, sans-serif',
        editor: {
            fontFamily:
                '"JetBrains Mono", "JetBrainsMonoNL Nerd Font", "Cascadia Code", Consolas, "Microsoft YaHei UI", monospace',
            fontSize: 15,
            lineHeight: 1.55,
            letterSpacing: 0,
            fontWeight: 400,
            ligatures: true,
            tabSize: 4,
            insertSpaces: true,
            wordWrap: false,
            minimap: false,
            minimapScale: 2,
            semanticCompletion: true,
            liveDiagnostics: true,
            formatOnSave: false,
            clangFormatStyle: DEFAULT_CLANG_FORMAT_STYLE,
            completion: {
                model: false,
                ai: { ...DEFAULT_AI_COMPLETION },
                showCompletionWhileInput: true,
                acceptOnEnter: false,
                minCharRequired: 1,
                sortByScope: true,
                recordUsage: true,
                showKeywords: true,
                ignoreCase: true,
                appendFunc: true,
                hideSymbolsStartsWithUnderLine: false,
                hideSymbolsStartsWithTwoUnderLine: true,
                snippets: []
            },
            vim: false
        },
        toolchain: {
            compiler: 'g++',
            flags: '-std=c++17 -O2 -Wall -Wextra -Wshadow',
            debugFlags: '-std=c++17 -g -O0 -Wall',
            gdb: 'gdb',
            clangd: 'clangd',
            clangFormat: 'clang-format',
            parallel: 4,
            outputLimitBytes: 64 * 1024 * 1024,
            displayLimitChars: 20000
        },
        terminal: { colors: [...DEFAULT_TERMINAL_COLORS] },
        template: DEFAULT_TEMPLATE,
        recentFiles: [],
        keybindings: {},
        pluginEnabled: {},
        sync: { clientId: BUILTIN_GITHUB_CLIENT_ID, repo: '', intervalMin: 30, maxFileBytes: 50 * 1024 * 1024 },
        autoSave: true
    }
}

/** Settings written before the completion ranker was renamed from `cnn` to `model`. */
export function migrateSettings<T extends object>(settings: T): T {
    const appearance = settings as { theme?: unknown }
    if (typeof appearance.theme === 'string') appearance.theme = canonicalThemeId(appearance.theme)
    const completion = (settings as { editor?: { completion?: Record<string, unknown> } }).editor?.completion
    if (completion && 'cnn' in completion) {
        if (completion.model === undefined) completion.model = completion.cnn
        delete completion.cnn
    }
    return settings
}

export function minimapScale(value: number | undefined): number {
    return value !== undefined && [1, 2, 3].includes(value) ? value : 2
}
