import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IterApi } from '../shared/api'
import type { IpcArgs, IpcChannel, IpcResult } from '../shared/ipc'

const invoke =
    <Channel extends IpcChannel>(channel: Channel) =>
    (...args: IpcArgs<Channel>): Promise<IpcResult<Channel>> =>
        ipcRenderer.invoke(channel, ...args)

function listen<T>(channel: string, cb: (payload: T) => void): () => void {
    const fn = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
    ipcRenderer.on(channel, fn)
    return () => ipcRenderer.removeListener(channel, fn)
}

// Files can arrive (argv / second instance) before the UI subscribes: buffer until someone listens.
let pendingOpen: string[] = []
const openListeners = new Set<(paths: string[]) => void>()
ipcRenderer.on('app:openFiles', (_e, paths: string[]) => {
    if (openListeners.size) openListeners.forEach((cb) => cb(paths))
    else pendingOpen.push(...paths)
})
function onOpenFiles(cb: (paths: string[]) => void): () => void {
    openListeners.add(cb)
    if (pendingOpen.length) {
        const paths = pendingOpen
        pendingOpen = []
        cb(paths)
    }
    return () => openListeners.delete(cb)
}

let pendingClose: { requestId: string } | undefined
const closeListeners = new Set<(request: { requestId: string }) => void>()
ipcRenderer.on('app:closeRequested', (_e, request: { requestId: string }) => {
    if (closeListeners.size) closeListeners.forEach((cb) => cb(request))
    else pendingClose = request
})
function onCloseRequest(cb: (request: { requestId: string }) => void): () => void {
    closeListeners.add(cb)
    if (pendingClose) {
        const request = pendingClose
        pendingClose = undefined
        cb(request)
    }
    return () => closeListeners.delete(cb)
}

const api: IterApi = {
    snapshots: {
        list: invoke('snapshots:list'),
        create: invoke('snapshots:create'),
        read: invoke('snapshots:read'),
        rename: invoke('snapshots:rename'),
        delete: invoke('snapshots:delete')
    },
    config: { export: invoke('config:export'), import: invoke('config:import') },
    toolchain: {
        status: invoke('toolchain:status'),
        healthState: invoke('toolchain:healthState'),
        check: invoke('toolchain:check'),
        cancelCheck: invoke('toolchain:cancelCheck'),
        onHealth: (cb) => listen('toolchain:health', cb)
    },
    format: { run: invoke('format:run') },
    fs: {
        readText: invoke('fs:readText'),
        writeText: invoke('fs:writeText'),
        exists: invoke('fs:exists'),
        createUntitled: invoke('fs:createUntitled'),
        discardUntitled: invoke('fs:discardUntitled'),
        sweepUntitled: invoke('fs:sweepUntitled'),
        openFileDialog: invoke('fs:openFileDialog'),
        saveFileDialog: invoke('fs:saveFileDialog'),
        pathForFile: (file: File) => webUtils.getPathForFile(file)
    },
    problem: {
        load: invoke('problem:load'),
        save: invoke('problem:save'),
        patch: invoke('problem:patch'),
        updateTest: invoke('problem:updateTest'),
        listTests: invoke('problem:listTests'),
        readTest: invoke('problem:readTest'),
        readTests: invoke('problem:readTests'),
        writeTest: invoke('problem:writeTest'),
        deleteTests: invoke('problem:deleteTests'),
        attachFile: invoke('problem:attachFile'),
        attachCode: invoke('problem:attachCode'),
        readAttached: invoke('problem:readAttached'),
        readChecker: invoke('problem:readChecker'),
        readInteractor: invoke('problem:readInteractor'),
        writeInteractor: invoke('problem:writeInteractor'),
        saved: invoke('problem:saved'),
        moveSource: invoke('problem:moveSource'),
        remove: invoke('problem:remove')
    },
    importer: {
        preview: invoke('importer:preview'),
        apply: invoke('importer:apply'),
        previewFolder: invoke('importer:previewFolder'),
        applyFolder: invoke('importer:applyFolder'),
        detectForSource: invoke('importer:detectForSource')
    },
    judge: {
        compile: invoke('judge:compile'),
        run: invoke('judge:run'),
        stop: invoke('judge:stop'),
        syntaxCheck: invoke('judge:syntaxCheck'),
        onEvent: (cb) => listen('judge:event', cb),
        modes: invoke('judge:modes'),
        describe: invoke('judge:describe')
    },
    terminal: {
        run: invoke('terminal:run'),
        stop: invoke('terminal:stop'),
        onExit: (cb) => listen('terminal:exit', cb)
    },
    debug: {
        start: invoke('debug:start'),
        command: invoke('debug:command'),
        setBreakpoints: invoke('debug:setBreakpoints'),
        evaluate: invoke('debug:evaluate'),
        inspect: invoke('debug:inspect'),
        locals: invoke('debug:locals'),
        children: invoke('debug:children'),
        stack: invoke('debug:stack'),
        runToCursor: invoke('debug:runToCursor'),
        selectFrame: invoke('debug:selectFrame'),
        breakpoints: invoke('debug:breakpoints'),
        seek: invoke('debug:seek'),
        onEvent: (cb) => listen('debug:event', cb)
    },
    apiHistory: {
        list: invoke('apiHistory:list'),
        delete: invoke('apiHistory:delete'),
        clear: invoke('apiHistory:clear'),
        onChanged: (callback) => listen('apiHistory:changed', callback)
    },
    inline: {
        complete: invoke('inline:complete'),
        cancel: (id) => ipcRenderer.send('inline:cancel', id)
    },
    model: {
        warmup: invoke('model:warmup'),
        rank: invoke('model:rank'),
        cancel: (id) => ipcRenderer.send('model:cancel', id)
    },
    lsp: {
        start: invoke('lsp:start'),
        send: (m) => ipcRenderer.send('lsp:send', m),
        onMessage: (cb) => listen('lsp:message', cb),
        restart: invoke('lsp:restart'),
        stop: invoke('lsp:stop'),
        refreshCompileFlags: invoke('lsp:refreshCompileFlags')
    },
    plugins: {
        list: invoke('plugins:list'),
        openFolder: invoke('plugins:openFolder'),
        panels: invoke('plugins:panels'),
        invoke: invoke('plugins:invoke'),
        reload: invoke('plugins:reload'),
        onChanged: (cb) => listen('plugins:changed', () => cb())
    },
    sync: {
        state: invoke('sync:state'),
        onState: (cb) => listen('sync:state', cb),
        loginDevice: invoke('sync:loginDevice'),
        loginToken: invoke('sync:loginToken'),
        logout: invoke('sync:logout'),
        syncNow: invoke('sync:syncNow')
    },
    settings: {
        get: invoke('settings:get'),
        set: invoke('settings:set'),
        userDirs: invoke('settings:userDirs'),
        listUserThemes: invoke('settings:listUserThemes'),
        onThemesChanged: (cb) => listen('app:themesChanged', () => cb()),
        listUserFonts: invoke('settings:listUserFonts'),
        openUserDir: invoke('settings:openUserDir')
    },
    session: { load: invoke('session:load'), save: invoke('session:save') },
    app: {
        platform: process.platform,
        onCloseRequest,
        resolveClose: invoke('app:resolveClose'),
        recover: invoke('app:recover'),
        rendererStatus: invoke('app:rendererStatus'),
        onOpenFiles,
        openExternal: invoke('app:openExternal'),
        confirmUnsaved: invoke('app:confirmUnsaved'),
        onNotify: (cb) => listen('app:notify', cb)
    }
}

// Sandboxed preloads expose argv, but intentionally have no process.env.
if (process.argv.includes('--iter-capture')) api.dev = { capture: invoke('dev:capture') }

contextBridge.exposeInMainWorld('iter', api)
