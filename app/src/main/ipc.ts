import { APP_NAME } from '../shared/brand'
import { LEGACY_CONFIG_EXTENSION } from '../shared/legacyBrand'
// Wires every `window.iter.*` call to its main-process module. Keep this file thin: no logic here.
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { externalUrl, trustedSender } from './security'
import type { IpcArgs, IpcChannel, IpcHandler } from '../shared/ipc'
import { validateIpcArguments } from './ipcValidation'
import type { Breakpoint, DebugCommand, DebugStartRequest } from '../shared/debug'
import type { ImportRequest, ProblemFolderImportRequest } from '../shared/importer'
import type { JudgeRequest } from '../shared/judge'
import type { TerminalRunRequest } from '../shared/terminal'
import type { ProblemConfig, ProblemSettingsPatch, TestMetaPatch } from '../shared/problem'
import type { AppSettings } from '../shared/settings'
import type { FormatRange } from '../shared/format'
import { runFormat } from './format'
import { configureToolchain } from './toolchain'
import { toolchainStatus } from './toolchain/status'
import { EnvironmentHealthService } from './environment/manager'
import { DebugManager } from './debug/manager'
import { applyImport, previewFiles, previewImport } from './importer'
import { applyFolder, detectForSource, previewFolder } from './importer/folder'
import { JudgeEngine } from './judge/engine'
import { disposeRunners } from './judge/runner'
import { ClangdBridge } from './lsp/clangd'
import { PluginManager } from './plugins/manager'
import * as store from './problem/store'
import { SettingsStore } from './settings'
import { SyncManager } from './sync'
import { exportConfig } from './configBundle/export'
import { importConfig } from './configBundle/import'
import { TerminalManager } from './terminal'
import { InlineAiService } from './ai/inline'
import { ApiHistory } from './ai/history'
import { openTerminalWindow } from './terminal/window'
import { ModelService } from './model/service'
import { loadSession, saveSession } from './session'
import { createUntitled, discardUntitled, sweepUntitled } from './untitled'
import type { SessionData } from '../shared/session'
import { SourceConflictError, writeSourceText } from './sourceFiles'
import type { SourceWriteOptions } from '../shared/sourceFile'
import * as snapshots from './snapshots'

export interface IpcServices {
    dispose(): Promise<void>
}
export function registerIpc(
    win: () => BrowserWindow | null,
    settings: SettingsStore,
    resolveClose: (requestId: string, decision: 'ready' | 'cancel') => Promise<void> = async () => {},
    rendererEntry = pathToFileURL(path.join(__dirname, '../renderer/index.html')).href,
    recover: (action: 'restart' | 'exit') => Promise<void> = async () => {
        throw new Error('恢复服务尚未就绪')
    },
    rendererStatus: (status: 'ready' | 'failed') => void = () => {}
): IpcServices {
    configureToolchain(
        path.join(
            app.isPackaged ? process.resourcesPath : app.getAppPath(),
            app.isPackaged ? 'toolchain' : 'resources/toolchain'
        )
    )
    const send = (channel: string, payload: unknown): void => {
        const w = win()
        if (w && !w.isDestroyed()) w.webContents.send(channel, payload)
    }
    const openDirectory = async (directory: string): Promise<void> => {
        const error = await shell.openPath(directory)
        if (error) throw new Error(`无法打开目录：${error}`)
    }
    const handle = <Channel extends IpcChannel>(channel: Channel, fn: IpcHandler<Channel>): void => {
        ipcMain.handle(channel, (event, ...args) => {
            if (!trustedSender(event, win()?.webContents, rendererEntry)) throw new Error('Untrusted IPC sender')
            validateIpcArguments(channel, args)
            return fn(...(args as IpcArgs<Channel>))
        })
    }
    const ranker = new ModelService({
        workerFile: path.join(__dirname, 'model-worker.js'),
        assets: path.join(
            app.isPackaged ? process.resourcesPath : app.getAppPath(),
            app.isPackaged ? 'model' : 'resources/model'
        ),
        library: path.join(
            app.isPackaged ? process.resourcesPath : app.getAppPath(),
            app.isPackaged ? 'toolchain/bin/libclang.dll' : 'resources/toolchain/bin/libclang.dll'
        ),
        scratch: path.join(app.getPath('userData'), 'cache/model'),
        enabled: () => settings.get().editor.semanticCompletion && settings.get().editor.completion.model === true,
        unavailable: () => send('app:notify', 'Model 加载失败，已使用原排序')
    })
    const history = new ApiHistory(() => send('apiHistory:changed', null))
    handle('apiHistory:list', () => history.snapshot())
    handle('apiHistory:delete', (id) => history.delete(id))
    handle('apiHistory:clear', () => history.clear())
    const inline = new InlineAiService(() => settings.get().editor.completion.ai, undefined, history)
    let lastInlineError = ''
    handle('inline:complete', async (request: unknown) => {
        const result = await inline.complete(request)
        if (result && 'error' in result && result.error !== lastInlineError)
            send('app:notify', `FIM Model：${result.error}`)
        lastInlineError = result && 'error' in result ? result.error : ''
        return result
    })
    ipcMain.on('inline:cancel', (event, id: unknown) => {
        if (trustedSender(event, win()?.webContents, rendererEntry) && typeof id === 'string') inline.cancel(id)
    })
    handle('model:warmup', () => ranker.prepare())
    handle('model:rank', (request: unknown) => ranker.rank(request))
    ipcMain.on('model:cancel', (event, id: unknown) => {
        if (trustedSender(event, win()?.webContents, rendererEntry) && typeof id === 'string') ranker.cancel(id)
    })

    // ---- fs ----
    handle('fs:readText', (p: string) => fs.readFile(p, 'utf8'))
    handle('fs:writeText', async (p: string, c: string, options?: SourceWriteOptions) => {
        try {
            await writeSourceText(p, c, options?.expected)
        } catch (error) {
            if (!(error instanceof SourceConflictError) || !options?.confirmOverwrite) throw error
            const window = win()
            if (!window || window.isDestroyed()) throw error
            const answer = await dialog.showMessageBox(window, {
                type: 'warning',
                message: `${path.basename(p)} 已在外部修改或删除`,
                detail: '覆盖会用当前编辑内容替换磁盘文件。取消会保留磁盘文件和当前编辑内容。',
                buttons: ['取消', '覆盖磁盘文件'],
                defaultId: 0,
                cancelId: 0,
                noLink: true
            })
            if (answer.response !== 1) throw error
            // Consent applies to the observed revision, not to any later external edit.
            await writeSourceText(p, c, error.actual)
        }
    })
    handle('fs:exists', (p: string) =>
        fs.access(p).then(
            () => true,
            () => false
        )
    )
    handle('fs:createUntitled', (index: number, text: string) => createUntitled(index, text))
    handle('fs:discardUntitled', (p: string) => discardUntitled(p))
    handle('fs:sweepUntitled', (keep: string[]) => sweepUntitled(keep))
    handle('fs:openFileDialog', async (opts?: { directory?: boolean; filters?: Electron.FileFilter[] }) => {
        const w = win()
        const r = await dialog.showOpenDialog(w!, {
            properties: opts?.directory ? ['openDirectory'] : ['openFile', 'multiSelections'],
            filters: opts?.filters
        })
        return r.canceled ? [] : r.filePaths
    })
    handle('fs:saveFileDialog', async (defaultPath?: string) => {
        const r = await dialog.showSaveDialog(win()!, {
            defaultPath,
            filters: [{ name: 'C++', extensions: ['cpp', 'cc', 'cxx'] }]
        })
        return r.canceled ? null : r.filePath
    })

    // ---- session (hot exit) ----
    handle('snapshots:list', snapshots.listSnapshots)
    handle('snapshots:create', snapshots.createSnapshot)
    handle('snapshots:read', snapshots.readSnapshot)
    handle('snapshots:rename', snapshots.renameSnapshot)
    handle('snapshots:delete', snapshots.deleteSnapshot)

    handle('session:load', () => loadSession(app.getPath('userData')))
    handle('session:save', (data: SessionData) => saveSession(app.getPath('userData'), data))
    handle('app:confirmUnsaved', async (name: string): Promise<'save' | 'discard' | 'cancel'> => {
        const r = await dialog.showMessageBox(win()!, {
            type: 'question',
            buttons: ['保存', '不保存', '取消'],
            defaultId: 0,
            cancelId: 2,
            noLink: true,
            message: `${name} 有未保存的修改`
        })
        return (['save', 'discard', 'cancel'] as const)[r.response]
    })

    // ---- problem ----
    handle('problem:load', (src: string) => store.loadProblem(src, (message) => send('app:notify', message)))
    handle('problem:save', (src: string, cfg: ProblemConfig) => store.saveProblem(src, cfg))
    handle('problem:patch', (src: string, patch: ProblemSettingsPatch) => store.patchProblem(src, patch))
    handle('problem:updateTest', (src: string, id: string, patch: TestMetaPatch) =>
        store.updateTestMeta(src, id, patch)
    )
    handle('problem:listTests', (src: string) => store.listTests(src))
    handle('problem:readTest', (src: string, id: string) =>
        store.readTest(src, id, settings.get().toolchain.displayLimitChars)
    )
    handle('problem:readTests', (src: string) => store.readTests(src, settings.get().toolchain.displayLimitChars))
    handle('problem:writeTest', (src: string, t: { id?: string; name?: string; input: string; answer: string }) =>
        store.writeTest(src, t)
    )
    handle('problem:deleteTests', (src: string, ids: string[]) => store.deleteTests(src, ids))
    handle('problem:attachFile', (src: string, file: string, role: 'checker' | 'interactor') =>
        store.attachFile(src, file, role)
    )
    handle('problem:attachCode', (src: string, code: string) => store.attachCode(src, String(code)))
    handle('problem:readAttached', (src: string, name: string) => store.readAttached(src, String(name)))
    handle('problem:readChecker', (src: string) => store.readChecker(src))
    handle('problem:readInteractor', (src: string) => store.readInteractor(src))
    handle(
        'problem:writeInteractor',
        (src: string, files: import('../shared/problem').JudgeSourceFile[], args?: string) =>
            store.writeInteractor(src, files, args)
    )
    handle('problem:saved', async (src: string, code: string) => {
        await store.ensureIdentity(src)
        await store.snapshotCode(src, code)
    })
    handle('problem:moveSource', (from: string, to: string) => store.moveSource(from, to))
    handle('problem:remove', (id: string) => store.removeProblem(id))

    // ---- importer ----
    handle('importer:preview', (p: string | string[]) => (Array.isArray(p) ? previewFiles(p) : previewImport(p)))
    handle('importer:apply', (req: ImportRequest) => applyImport(req, (message) => send('app:notify', message)))
    handle('importer:previewFolder', (dir: string) => previewFolder(dir))
    handle('importer:applyFolder', (req: ProblemFolderImportRequest) =>
        applyFolder(req, (message) => send('app:notify', message))
    )
    handle('importer:detectForSource', (src: string) => detectForSource(src))

    // ---- judge ----
    handle('toolchain:status', () => toolchainStatus(settings.get().toolchain))
    const health = new EnvironmentHealthService(
        () => settings.get().toolchain,
        app.getVersion(),
        (state) => send('toolchain:health', state)
    )
    handle('toolchain:healthState', () => health.state())
    handle('toolchain:check', () => health.start())
    handle('toolchain:cancelCheck', () => health.cancel())
    handle('format:run', (src: string, code: string, range?: FormatRange) =>
        runFormat(src, code, settings.get(), range)
    )
    const judge = new JudgeEngine(
        () => settings.get().toolchain,
        (e) => send('judge:event', e)
    )
    handle('judge:compile', (src: string, code: string, debug?: boolean) => judge.compile(src, code, !!debug))
    handle('judge:run', (req: JudgeRequest) => judge.run(req))
    handle('judge:stop', (id?: string) => judge.stop(id))
    handle('judge:syntaxCheck', (src: string, code: string) => judge.syntaxCheck(src, code))
    handle('judge:modes', () => judge.modes())
    handle('judge:describe', (src: string) => judge.describe(src))

    const terminal = new TerminalManager(
        () => settings.get().toolchain,
        path.join(app.getPath('userData'), 'terminal'),
        openTerminalWindow,
        (runId) => send('terminal:exit', { runId }),
        () => settings.get().terminal.colors
    )
    handle('terminal:run', (req: TerminalRunRequest) => terminal.run(req))
    handle('terminal:stop', (id?: string) => terminal.stop(id))

    // ---- debug ----
    const debug = new DebugManager(
        judge,
        () => settings.get().toolchain,
        (e) => send('debug:event', e)
    )
    handle('debug:start', (req: DebugStartRequest) => debug.start(req))
    handle('debug:command', (cmd: DebugCommand) => debug.command(cmd))
    handle('debug:setBreakpoints', (src: string, bps: Breakpoint[]) => debug.setBreakpoints(src, bps))
    handle('debug:evaluate', (expr: string) => debug.evaluate(expr))
    handle('debug:inspect', (expr: string) => debug.inspect(expr))
    handle('debug:locals', () => debug.locals())
    handle('debug:children', (ref: string) => debug.children(ref))
    handle('debug:stack', () => debug.stack())
    handle('debug:runToCursor', (src: string, line: number) => debug.runToCursor(src, line))
    handle('debug:selectFrame', (level: number) => debug.selectFrame(level))
    handle('debug:breakpoints', () => debug.breakpoints())
    handle('debug:seek', (index: number) => debug.seek(index))

    // ---- lsp ----
    const clangd = new ClangdBridge(
        (m) => send('lsp:message', m),
        () => settings.get()
    )
    handle('lsp:start', (root: string) => {
        ranker.prepare()
        const tc = settings.get().toolchain
        clangd.setToolchain(tc.compiler, tc.flags)
        return clangd.start(root, tc.clangd)
    })
    ipcMain.on('lsp:send', (event, m) => {
        if (trustedSender(event, win()?.webContents, rendererEntry)) clangd.send(m)
    })
    handle('lsp:restart', () => clangd.restart(settings.get().toolchain.clangd))
    handle('lsp:stop', () => clangd.stop())
    handle('lsp:refreshCompileFlags', (src: string) => clangd.refreshCompileFlags(src))

    // ---- plugins ----
    const plugins = new PluginManager(
        settings.userDirs().plugins,
        (msg) => send('app:notify', msg),
        () => send('plugins:changed', undefined),
        (id) => settings.get().pluginEnabled?.[id] !== false
    )
    void plugins.loadAll()
    handle('plugins:panels', () => plugins.panels())
    handle('plugins:invoke', (pluginId: string, channel: string, args: unknown[]) =>
        plugins.invoke(pluginId, channel, args)
    )
    handle('plugins:reload', () => plugins.reload())
    handle('plugins:list', () => plugins.list())
    handle('plugins:openFolder', () => openDirectory(settings.userDirs().plugins))

    // ---- settings ----
    handle('settings:get', () => settings.get())
    handle('settings:set', (patch: Partial<AppSettings>) => {
        const next = settings.set(patch)
        ranker.prepare()
        return next
    })
    handle('settings:userDirs', () => settings.userDirs())
    handle('settings:listUserThemes', () => settings.listUserThemes())
    handle('settings:listUserFonts', () => settings.listUserFonts())
    handle('settings:openUserDir', (kind: 'themes' | 'fonts' | 'plugins') => openDirectory(settings.userDirs()[kind]))

    // ---- configuration bundles ----
    handle('config:export', async (targetPath?: string) => {
        if (targetPath === undefined) {
            const options: Electron.SaveDialogOptions = {
                defaultPath: `iter-config-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.iterconf`,
                filters: [{ name: `${APP_NAME} configuration`, extensions: ['iterconf'] }]
            }
            const window = win()
            const result = await (window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options))
            if (result.canceled || !result.filePath) return null
            targetPath = result.filePath
        }
        return exportConfig(targetPath, settings)
    })
    handle('config:import', async (sourcePath?: string) => {
        if (sourcePath === undefined) {
            const options: Electron.OpenDialogOptions = {
                properties: ['openFile'],
                filters: [{ name: `${APP_NAME} configuration`, extensions: ['iterconf', LEGACY_CONFIG_EXTENSION] }]
            }
            const window = win()
            const result = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options))
            if (result.canceled || !result.filePaths[0]) return null
            sourcePath = result.filePaths[0]
        }
        const summary = await importConfig(sourcePath, settings)
        send('app:themesChanged', undefined)
        await plugins.reload()
        return summary
    })

    // ---- sync ----
    const sync = new SyncManager(settings, (s) => send('sync:state', s))
    handle('sync:state', () => sync.state())
    handle('sync:loginDevice', () => sync.loginDevice())
    handle('sync:loginToken', (token: string) => sync.loginToken(token))
    handle('sync:logout', () => sync.logout())
    handle('sync:syncNow', () => sync.syncNow())

    handle('app:openExternal', (url: unknown) => shell.openExternal(externalUrl(url)))
    handle('app:recover', recover)
    handle('app:rendererStatus', rendererStatus)

    ipcMain.handle('app:resolveClose', async (event, requestId: unknown, decision: unknown) => {
        if (
            !trustedSender(event, win()?.webContents, rendererEntry) ||
            typeof requestId !== 'string' ||
            (decision !== 'ready' && decision !== 'cancel')
        )
            throw new Error('Invalid close response')
        await resolveClose(requestId, decision)
    })
    let disposing: Promise<void> | undefined
    return {
        dispose: () =>
            (disposing ??= (async () => {
                const results = await Promise.allSettled([
                    judge.dispose(),
                    terminal.dispose(),
                    debug.dispose(),
                    clangd.stop(),
                    ranker.dispose(),
                    health.dispose(),
                    sync.dispose(),
                    plugins.dispose()
                ])
                const runnerResult = await Promise.allSettled([disposeRunners()])
                results.push(...runnerResult)
                const failure = results.find((result) => result.status === 'rejected')
                if (failure?.status === 'rejected') {
                    disposing = undefined
                    throw failure.reason
                }
            })())
    }
}
