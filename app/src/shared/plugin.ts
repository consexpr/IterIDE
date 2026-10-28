// Plugin contract. A plugin lives in `<userData>/plugins/<id>/` (or `app/plugins/<id>/` for
// bundled ones) with a `iter-plugin.json` manifest and a CommonJS entry exporting `activate(ctx)`.
// Plugins run in the main process. They never receive user credentials from ITER: logging in happens
// inside a plugin-owned browser window whose cookies persist per plugin (`ctx.openWindow`).

export interface PluginManifest {
    id: string // e.g. "my-plugin"
    name: string // e.g. "我的插件"
    version: string
    main: string // entry file relative to the plugin dir
    description?: string
}

/** What a plugin's activate() receives. Kept in sync with docs/plugins.md. */
export interface PluginHost {
    /** Register a judge mode, removed automatically when this plugin unloads. */
    registerJudgeMode(mode: import('../main/judge/modes/registry').JudgeModePlugin): void
    /** Open (or focus) a browser window with a per-plugin persistent session. Returns an Electron BrowserWindow. */
    openWindow(url: string, opts?: { width?: number; height?: number; show?: boolean }): Promise<unknown>
    /**
     * Contribute a page to the right-hand side panel. `entry` is an HTML file in the plugin folder,
     * shown in a sandboxed iframe (served from iter://plugins/<id>/…). It talks to ITER through the
     * panel bridge (`iter://sdk/panel.js`, see docs/plugin-api.md).
     */
    registerPanel(panel: { id: string; title: string; entry: string }): void
    /** Handle `invoke(channel, ...args)` calls coming from this plugin's panels. */
    handle(channel: string, fn: (...args: unknown[]) => unknown): void
    /** A writable directory owned by this plugin (under the user data dir); survives updates. */
    readonly dataDir: string
    log(message: string): void
    notify(message: string): void
}

/** A side-panel page contributed by a plugin. */
export interface PanelInfo {
    pluginId: string
    id: string
    title: string
    /** URL the renderer loads in the iframe. */
    url: string
}

/** Snapshot pushed to plugin panels whenever something relevant changes. */
export interface PanelState {
    file: { path: string; name: string } | null
    problem: unknown | null // ProblemConfig; kept loose so plugins don't depend on internal types
    tests: { id: string; name: string; enabled: boolean }[]
    results: Record<string, { verdict: string; timeMs: number; memoryKb?: number }>
    debugging: boolean
    theme: { id: string; kind: 'dark' | 'light'; vars: Record<string, string> }
}

/** Requests a panel may send (`iter:request` messages). */
export type PanelMethod =
    | 'invoke' // (channel, ...args) → the plugin's own main-process handler
    | 'getSource' // () → current editor text
    | 'insertText' // (text) → insert at the cursor
    | 'openFile' // (path)
    | 'runTests' // (ids?: string[])
    | 'toast' // (text, kind?: 'info' | 'success' | 'error')
    | 'setBadge' // (text | null) → small badge on the panel's tab
