// The renderer-facing API exposed by preload as `window.iter`.
// Every method maps 1:1 to an ipcMain.handle channel named `<group>:<method>` (see main/ipc.ts).
import type {
    Breakpoint,
    BreakpointInfo,
    DebugCommand,
    DebugEvent,
    DebugStartRequest,
    StackFrame,
    Variable
} from './debug'
import type {
    FolderImportPreview,
    ImportPreview,
    ImportRequest,
    ProblemFolderImportRequest,
    ProblemFolderPreview
} from './importer'
import type { CompileResult, Diagnostic, JudgeEvent, JudgeRequest, ToolchainSettings, ToolchainStatus } from './judge'
import type { FormatRange, FormatResult } from './format'
import type { PanelInfo } from './plugin'
import type { JudgeModeInfo, JudgeModeSummary } from './judgeMode'
import type { SyncResult, SyncState } from './sync'
import type { ProblemConfig, ProblemSettingsPatch, TestMetaPatch, TestCaseData } from './problem'
import type { JudgeSourceFile } from './problem'
import type { ApiHistoryState } from './apiHistory'
import type { AppSettings } from './settings'
import type { ImportSummary } from './config'
import type { EnvironmentHealth } from './environment'
import type { TerminalRunRequest, TerminalRunResult } from './terminal'
import type { ModelRequest, ModelResult } from './model'
import type { InlineRequest, InlineResult } from './inlineAi'
import type { SessionData } from './session'
import type { SourceWriteOptions } from './sourceFile'
import type { CodeSnapshot, SnapshotContent } from './snapshots'

export interface IterApi {
    snapshots: {
        list(sourcePath: string): Promise<CodeSnapshot[]>
        create(sourcePath: string, code: string, name?: string): Promise<CodeSnapshot>
        read(sourcePath: string, id: string): Promise<SnapshotContent>
        rename(sourcePath: string, id: string, name: string): Promise<void>
        delete(sourcePath: string, id: string): Promise<void>
    }
    config: {
        export(path?: string): Promise<string | null>
        import(path?: string): Promise<ImportSummary | null>
    }
    toolchain: {
        status(): Promise<ToolchainStatus>
        healthState(): Promise<EnvironmentHealth>
        check(): Promise<EnvironmentHealth>
        cancelCheck(): Promise<void>
        onHealth(cb: (state: EnvironmentHealth) => void): () => void
    }
    format: { run(sourcePath: string, code: string, range?: FormatRange): Promise<FormatResult> }
    /** Only present when launched with ITER_CAPTURE (UI automation for development). */
    dev?: { capture(file: string): Promise<void> }
    fs: {
        readText(path: string): Promise<string>
        writeText(path: string, content: string, options?: SourceWriteOptions): Promise<void>
        exists(path: string): Promise<boolean>
        /** A new `Untitled-N.cpp` in the app-managed folder, holding `text`; returns its path. */
        createUntitled(index: number, text: string): Promise<string>
        /** Delete a managed file together with its stored tests. */
        discardUntitled(path: string): Promise<void>
        /** Delete managed files that are not in `keep`. */
        sweepUntitled(keep: string[]): Promise<void>
        openFileDialog(opts?: {
            directory?: boolean
            filters?: { name: string; extensions: string[] }[]
        }): Promise<string[]>
        saveFileDialog(defaultPath?: string): Promise<string | null>
        /** Absolute path of a File dropped from the OS (Electron webUtils). */
        pathForFile(file: File): string
    }
    problem: {
        /** Load (creating if missing) the problem bound to a source file. */
        load(sourcePath: string): Promise<ProblemConfig>
        save(sourcePath: string, config: ProblemConfig): Promise<void>
        /** Merge editable settings into the latest config under its storage lock. */
        patch(sourcePath: string, patch: ProblemSettingsPatch): Promise<ProblemConfig>
        updateTest(sourcePath: string, id: string, patch: TestMetaPatch): Promise<ProblemConfig>
        /** List metadata without loading every test's input and answer into memory. */
        listTests(sourcePath: string): Promise<TestCaseData[]>
        /** Load the bounded preview of one test when it is expanded or edited. */
        readTest(sourcePath: string, id: string): Promise<TestCaseData>
        readTests(sourcePath: string): Promise<TestCaseData[]>
        /** Create or overwrite one test; returns its meta id. */
        writeTest(
            sourcePath: string,
            test: { id?: string; name?: string; input: string; answer: string }
        ): Promise<string>
        deleteTests(sourcePath: string, ids: string[]): Promise<void>
        /** Copy a checker / interactor file into the problem dir, returns its relative path. */
        attachFile(sourcePath: string, file: string, role: 'checker' | 'interactor'): Promise<string>
        /** Save pasted checker source into the problem dir, returns its relative path. */
        attachCode(sourcePath: string, code: string): Promise<string>
        /** Source of a managed attachment (a plain name or cached resource path), or null. */
        readAttached(sourcePath: string, name: string): Promise<string | null>
        /** Current checker source, regardless of its import origin; null for a binary checker. */
        readChecker(sourcePath: string): Promise<string | null>
        readInteractor(sourcePath: string): Promise<JudgeSourceFile[] | null>
        writeInteractor(sourcePath: string, files: JudgeSourceFile[], args?: string): Promise<ProblemConfig>
        /** After the editor saved the file: keep its ID and refresh the stored code snapshot. */
        saved(sourcePath: string, code: string): Promise<void>
        /** The solution now lives at `to` (already written): its tests and settings follow. */
        moveSource(from: string, to: string): Promise<void>
        /** Delete a stored problem (only orphans; the UI confirms first). */
        remove(id: string): Promise<void>
    }
    importer: {
        /** Analyse a dropped folder / zip without touching the problem. */
        preview(path: string | string[]): Promise<ImportPreview>
        apply(req: ImportRequest): Promise<{ added: number }>
        /** Analyse a folder as one problem or a contest of problems (one per subfolder). */
        previewFolder(dir: string): Promise<FolderImportPreview>
        /** Bind/create the solution and set up tests, checker, interactor, grader in one go. */
        applyFolder(req: ProblemFolderImportRequest): Promise<{ sourcePath: string; added: number }>
        /** Suggest the surrounding problem folder only when this solution has no tests. */
        detectForSource(sourcePath: string): Promise<ProblemFolderPreview | null>
    }
    judge: {
        compile(sourcePath: string, source: string, debug?: boolean): Promise<CompileResult>
        /** Starts a run and returns its id; progress arrives through onEvent. */
        run(req: JudgeRequest): Promise<string>
        stop(runId?: string): Promise<void>
        /** Fast syntax-only check used as a fallback when clangd is unavailable. */
        syntaxCheck(sourcePath: string, source: string): Promise<Diagnostic[]>
        onEvent(cb: (e: JudgeEvent) => void): () => void
        /** Installed judge modes (built-in + plugins). */
        modes(): Promise<JudgeModeSummary[]>
        /** Info-bar description of the active mode for this source. */
        describe(sourcePath: string): Promise<JudgeModeInfo>
    }
    terminal: {
        run(req: TerminalRunRequest): Promise<TerminalRunResult>
        stop(runId?: string): Promise<void>
        onExit(cb: (event: { runId: string }) => void): () => void
    }
    debug: {
        start(req: DebugStartRequest): Promise<void>
        command(cmd: DebugCommand): Promise<void>
        setBreakpoints(sourcePath: string, bps: Breakpoint[]): Promise<void>
        evaluate(expr: string): Promise<{ value: string; type?: string } | null>
        /** Automatic hover inspection; rejects calls/mutations and disables inferior calls. */
        inspect(expr: string): Promise<{ value: string; type?: string } | null>
        locals(): Promise<Variable[]>
        children(ref: string): Promise<Variable[]>
        stack(): Promise<StackFrame[]>
        runToCursor(sourcePath: string, line: number): Promise<void>
        selectFrame(level: number): Promise<void>
        breakpoints(): Promise<BreakpointInfo[]>
        seek(index: number): Promise<void>
        onEvent(cb: (e: DebugEvent) => void): () => void
    }
    apiHistory: {
        list(): Promise<ApiHistoryState>
        delete(id: string): Promise<void>
        clear(): Promise<void>
        onChanged(callback: () => void): () => void
    }
    inline: {
        /** Ghost-text completion for the code around the cursor; null when disabled or cancelled. */
        complete(request: InlineRequest): Promise<InlineResult>
        cancel(id: string): void
    }
    model: {
        warmup(): Promise<void>
        rank(request: ModelRequest): Promise<ModelResult | null>
        cancel(id: string): void
    }
    lsp: {
        /** Start (or reuse) clangd for a workspace root. Returns false when clangd is unavailable. */
        start(rootDir: string): Promise<boolean>
        /** Send a raw JSON-RPC message (object) to clangd. */
        send(message: unknown): void
        onMessage(cb: (message: unknown) => void): () => void
        /** Kill and respawn clangd (or start it again if it gave up); false when there is no workspace yet. */
        restart(): Promise<boolean>
        stop(): Promise<void>
        /** Re-send this file's compile command (after its judge mode / include dirs changed). */
        refreshCompileFlags(sourcePath: string): Promise<void>
    }
    plugins: {
        list(): Promise<{ id: string; name: string; version: string; enabled: boolean; error?: string }[]>
        openFolder(): Promise<void>
        /** Side-panel pages contributed by plugins. */
        panels(): Promise<PanelInfo[]>
        /** Forward a panel's `invoke` to the plugin's main-process handler. */
        invoke(pluginId: string, channel: string, args: unknown[]): Promise<unknown>
        reload(): Promise<void>
        onChanged(cb: () => void): () => void
    }
    sync: {
        state(): Promise<SyncState>
        onState(cb: (s: SyncState) => void): () => void
        /** Browser login (GitHub device flow); needs `settings.sync.clientId`. */
        loginDevice(): Promise<void>
        /** Login with a fine-grained personal access token pasted by the user. */
        loginToken(token: string): Promise<void>
        logout(): Promise<void>
        syncNow(): Promise<SyncResult>
    }
    settings: {
        get(): Promise<AppSettings>
        set(patch: Partial<AppSettings>): Promise<AppSettings>
        /** User theme/font folders; files there are picked up on reload. */
        userDirs(): Promise<{ themes: string; fonts: string; plugins: string }>
        listUserThemes(): Promise<unknown[]>
        /** Fires when files in the user themes dir change (live reload for theme authors). */
        onThemesChanged(cb: () => void): () => void
        listUserFonts(): Promise<{ family: string; file: string }[]>
        openUserDir(kind: 'themes' | 'fonts' | 'plugins'): Promise<void>
    }
    session: {
        load(): Promise<SessionData | null>
        save(data: SessionData): Promise<void>
    }
    app: {
        platform: string
        /** Save / Don't save / Cancel for a tab being closed. */
        confirmUnsaved(name: string): Promise<'save' | 'discard' | 'cancel'>
        onCloseRequest(cb: (request: { requestId: string }) => void): () => void
        resolveClose(requestId: string, decision: 'ready' | 'cancel'): Promise<void>
        /** User-selected recovery after an unrecoverable renderer error. */
        recover(action: 'restart' | 'exit'): Promise<void>
        rendererStatus(status: 'ready' | 'failed'): Promise<void>
        onOpenFiles(cb: (paths: string[]) => void): () => void
        openExternal(url: string): Promise<void>
        /** Toasts pushed by main (plugins, background tasks). */
        onNotify(cb: (message: string) => void): () => void
    }
}

export type { ToolchainSettings }
