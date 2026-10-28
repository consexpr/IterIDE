import { app, BrowserWindow, dialog, net, protocol, shell } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { maybeCapture } from './devCapture'
import { registerIpc, type IpcServices } from './ipc'
import { ShutdownCoordinator } from './shutdown'
import { SettingsStore } from './settings'
import { watchThemes } from './themes'
import { configureStoragePaths } from './storagePaths'
import { externalUrl, sameDocument } from './security'
import { userAssetPath } from './userAssets'
import { servePluginRequest } from './plugins/protocol'
import { APP_NAME } from '../shared/brand'
import { LEGACY_SCHEME } from '../shared/legacyBrand'
import { appIcon } from './branding'

app.setName(APP_NAME)
configureStoragePaths(app)

protocol.registerSchemesAsPrivileged(
    ['iter', LEGACY_SCHEME].map((scheme) => ({
        scheme,
        privileges: { standard: true, secure: true, supportFetchAPI: true }
    }))
)

let mainWindow: BrowserWindow | null = null
let services: IpcServices | undefined
let shutdown: ShutdownCoordinator | undefined
let requestWindowClose: (() => void) | undefined
let setRendererStatus: ((status: 'ready' | 'failed') => void) | undefined
const rendererEntry =
    (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) ||
    pathToFileURL(path.join(__dirname, '../renderer/index.html')).href

function openWebLink(url: string): void {
    try {
        void shell.openExternal(externalUrl(url)).catch(() => console.warn('[iter] could not open web link'))
    } catch {
        /* Ignore unsupported schemes from a page or plugin panel. */
    }
}

function filesFromArgv(argv: string[]): string[] {
    return argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-') && /\.(cpp|cc|cxx)$/i.test(a))
}

function createWindow(): void {
    mainWindow = new BrowserWindow({
        title: APP_NAME,
        icon: appIcon(),
        width: 1440,
        height: 900,
        minWidth: 960,
        minHeight: 600,
        show: false,
        frame: false,
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: '#00000000', symbolColor: '#9aa4b2', height: 38 },
        backgroundColor: '#16181d',
        webPreferences: {
            preload: path.join(__dirname, '../preload/index.js'),
            sandbox: true,
            nodeIntegration: false,
            contextIsolation: true,
            additionalArguments: process.env['ITER_CAPTURE'] ? ['--iter-capture'] : []
        }
    })
    const window = mainWindow
    const coordinator = new ShutdownCoordinator({
        request: (request) => window.webContents.send('app:closeRequested', request),
        dispose: () => services?.dispose() ?? Promise.resolve(),
        close: (restart) => {
            if (restart === undefined) {
                window.close()
                return
            }
            if (restart) app.relaunch()
            window.destroy()
            app.quit()
        },
        notify: (message) => {
            if (!window.isDestroyed()) window.webContents.send('app:notify', message)
        }
    })
    shutdown = coordinator
    let rendererFailed = false
    let rendererBooted = false
    let bootStalled = false
    let bootTimer: ReturnType<typeof setTimeout> | undefined
    let recoveryDialog: Promise<void> | undefined
    const offerRecovery = (canWait = false): Promise<void> => {
        if (recoveryDialog || window.isDestroyed() || coordinator.canClose) return recoveryDialog ?? Promise.resolve()
        window.show()
        recoveryDialog = (async () => {
            const result = await dialog.showMessageBox(window, {
                type: 'error',
                title: APP_NAME,
                message: canWait ? '编辑器暂时没有响应' : '编辑器无法继续运行',
                detail: '重新启动会恢复最近保存的会话。尚未写入会话的编辑内容可能无法恢复。',
                buttons: canWait ? ['继续等待', '重新启动', '退出'] : ['重新启动', '退出'],
                defaultId: 0,
                cancelId: canWait ? 0 : 1,
                noLink: true
            })
            if (canWait && result.response === 0) return
            await coordinator.recover(result.response === (canWait ? 1 : 0) ? 'restart' : 'exit')
        })()
            .catch((error) => {
                console.error('[iter] recovery dialog failed', error)
            })
            .finally(() => {
                recoveryDialog = undefined
            })
        return recoveryDialog
    }
    requestWindowClose = () => {
        if (rendererFailed || bootStalled) void offerRecovery(bootStalled && !rendererFailed)
        else coordinator.request()
    }
    setRendererStatus = (status) => {
        if (rendererFailed && status === 'ready') return
        clearTimeout(bootTimer)
        rendererBooted = true
        bootStalled = false
        rendererFailed = status === 'failed'
    }
    window.on('close', (event) => {
        if (coordinator.canClose) return
        event.preventDefault()
        requestWindowClose?.()
    })
    window.on('closed', () => {
        clearTimeout(bootTimer)
        if (mainWindow === window) {
            mainWindow = null
            shutdown = undefined
            requestWindowClose = undefined
            setRendererStatus = undefined
        }
    })
    window.webContents.on('render-process-gone', (_event, details) => {
        if (coordinator.canClose) return
        clearTimeout(bootTimer)
        rendererFailed = true
        console.error('[iter] renderer exited', details.reason)
        void offerRecovery()
    })
    window.on('unresponsive', () => void offerRecovery(true))
    mainWindow.on('ready-to-show', () => mainWindow?.show())
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        openWebLink(url)
        return { action: 'deny' }
    })
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (sameDocument(url, rendererEntry)) return
        event.preventDefault()
        openWebLink(url)
    })
    mainWindow.webContents.on('will-redirect', (event, url) => {
        if (!sameDocument(url, rendererEntry)) event.preventDefault()
    })
    mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())
    mainWindow.webContents.on('did-finish-load', () => {
        const files = filesFromArgv(process.argv)
        if (files.length) mainWindow?.webContents.send('app:openFiles', files)
        if (!rendererBooted)
            bootTimer = setTimeout(() => {
                bootStalled = true
                void offerRecovery(true)
            }, 30_000)
    })
    maybeCapture(mainWindow, rendererEntry)
    void mainWindow.loadURL(rendererEntry).catch((error) => {
        rendererFailed = true
        console.error('[iter] renderer could not load', error)
        void offerRecovery()
    })
}

const single = app.requestSingleInstanceLock()
if (!single) app.quit()
else {
    app.on('second-instance', (_e, argv) => {
        if (!mainWindow) return
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.focus()
        const files = filesFromArgv(argv)
        if (files.length) mainWindow.webContents.send('app:openFiles', files)
    })

    void app
        .whenReady()
        .then(() => {
            const settings = new SettingsStore()
            // iter://fonts/<file> serves user fonts so themes/fonts stay pluggable without bundling.
            // iter://themes/<pkg>/<file> serves theme package assets (css, images, fonts).
            const serveAsset = async (req: Request): Promise<Response> => {
                const u = new URL(req.url)
                if (u.host === 'plugins' || u.host === 'sdk') {
                    return servePluginRequest(req.url)
                }
                const dirs = settings.userDirs()
                const file =
                    u.host === 'fonts'
                        ? await userAssetPath(dirs.fonts, u.pathname, true)
                        : u.host === 'themes'
                          ? await userAssetPath(dirs.themes, u.pathname)
                          : null
                if (!file) return new Response('not found', { status: 404 })
                return net.fetch(pathToFileURL(file).toString())
            }
            protocol.handle('iter', serveAsset)
            protocol.handle(LEGACY_SCHEME, serveAsset)
            watchThemes(settings.userDirs().themes, () => mainWindow?.webContents.send('app:themesChanged'))
            services = registerIpc(
                () => mainWindow,
                settings,
                async (id, decision) => {
                    await shutdown?.resolve(id, decision)
                },
                rendererEntry,
                async (action) => {
                    if (!shutdown) throw new Error('恢复服务尚未就绪')
                    await shutdown.recover(action)
                },
                (status) => setRendererStatus?.(status)
            )
            createWindow()
        })
        .catch((e) => {
            console.error('[iter] startup failed', e)
            dialog.showErrorBox(`${APP_NAME} 无法启动`, e instanceof Error ? e.message : String(e))
            app.exit(1)
        })
    app.on('window-all-closed', () => app.quit())
    app.on('before-quit', (event) => {
        if (!mainWindow || !shutdown || shutdown.canClose) return
        event.preventDefault()
        requestWindowClose?.()
    })
}
