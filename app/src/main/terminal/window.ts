import { app, BrowserWindow, shell } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { terminalColors } from '../../shared/settings'
import { externalUrl, trustedSender } from '../security'
import type { TerminalView } from './host'
import { TERMINAL_MAX_OUTPUT_FRAME_BYTES } from '../../shared/terminal'
import { APP_NAME } from '../../shared/brand'
import { appIcon } from '../branding'

function entryUrl(colors: string[]): string {
    const base = (
        !app.isPackaged && process.env['ELECTRON_RENDERER_URL']
            ? new URL('terminal.html', process.env['ELECTRON_RENDERER_URL'].replace(/\/?$/, '/'))
            : pathToFileURL(path.join(__dirname, '../renderer/terminal.html'))
    ).href
    const url = new URL(base)
    url.searchParams.set(
        'colors',
        terminalColors(colors)
            .map((color) => color.slice(1))
            .join(',')
    )
    return url.href
}

/** One window per terminal run: an xterm.js view with the title and spinner outside the scrolling output. */
export function openTerminalWindow(colors: string[]): Promise<TerminalView> {
    const entry = entryUrl(colors)
    const win = new BrowserWindow({
        width: 900,
        height: 560,
        minWidth: 360,
        minHeight: 240,
        show: false,
        title: `${APP_NAME} - Terminal`,
        icon: appIcon(),
        autoHideMenuBar: true,
        backgroundColor: '#0c0c0c',
        webPreferences: {
            preload: path.join(__dirname, '../preload/terminal.js'),
            sandbox: true,
            nodeIntegration: false,
            contextIsolation: true
        }
    })
    win.removeMenu()
    const contents = win.webContents
    contents.setWindowOpenHandler(({ url }) => {
        try {
            void shell.openExternal(externalUrl(url)).catch(() => {})
        } catch {
            /* Only web links may leave the application. */
        }
        return { action: 'deny' }
    })
    contents.on('will-navigate', (event) => event.preventDefault())
    contents.on('will-attach-webview', (event) => event.preventDefault())
    // The page title is fixed so the window caption does not change.
    win.on('page-title-updated', (event) => event.preventDefault())

    const closed = new Promise<void>((resolve) => win.once('closed', () => resolve()))
    let sequence = 0
    const pendingWrites = new Map<number, () => void>()
    void closed.then(() => {
        for (const resolve of pendingWrites.values()) resolve()
        pendingWrites.clear()
    })
    const inputs: ((data: string) => void)[] = []
    const resizes: ((cols: number, rows: number) => void)[] = []
    const trusted = (event: Parameters<typeof trustedSender>[0]): boolean => trustedSender(event, contents, entry)
    const alive = (): boolean => !win.isDestroyed() && !contents.isDestroyed()
    const number = (value: unknown): value is number =>
        Number.isInteger(value) && (value as number) >= 2 && (value as number) <= 1000
    contents.on('render-process-gone', () => {
        if (!win.isDestroyed()) win.destroy()
    })
    contents.ipc.on('terminal:ack', (event, id: unknown) => {
        if (!trusted(event) || typeof id !== 'number' || !Number.isSafeInteger(id)) return
        const resolve = pendingWrites.get(id)
        if (resolve) {
            pendingWrites.delete(id)
            resolve()
        }
    })

    return new Promise<TerminalView>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error('终端窗口启动超时'))
            win.destroy()
        }, 10_000)
        void closed.then(() => {
            clearTimeout(timer)
            reject(new Error('终端窗口已关闭'))
        })
        contents.ipc.on('terminal:ready', (event, size: { cols?: unknown; rows?: unknown }) => {
            if (!trusted(event) || !number(size?.cols) || !number(size?.rows)) return
            clearTimeout(timer)
            resolve({
                cols: size.cols,
                rows: size.rows,
                closed,
                write: (data) => {
                    if (!alive()) {
                        if (!win.isDestroyed()) win.destroy()
                        return Promise.resolve()
                    }
                    if (data.byteLength > TERMINAL_MAX_OUTPUT_FRAME_BYTES)
                        return Promise.reject(new Error('Terminal output frame exceeds limit'))
                    const id = ++sequence
                    return new Promise<void>((resolveWrite) => {
                        pendingWrites.set(id, resolveWrite)
                        try {
                            contents.send('terminal:data', data, id)
                        } catch {
                            pendingWrites.delete(id)
                            resolveWrite()
                            if (alive()) win.destroy()
                        }
                    })
                },
                exited: (code) => alive() && contents.send('terminal:exit', code),
                onInput: (listener) => void inputs.push(listener),
                onResize: (listener) => void resizes.push(listener),
                close: () => {
                    if (!win.isDestroyed()) win.destroy()
                }
            })
            win.show()
        })
        contents.ipc.on('terminal:input', (event, data: unknown) => {
            if (trusted(event) && typeof data === 'string' && data.length <= 1 << 20) for (const fn of inputs) fn(data)
        })
        contents.ipc.on('terminal:resize', (event, size: { cols?: unknown; rows?: unknown }) => {
            if (trusted(event) && number(size?.cols) && number(size?.rows))
                for (const fn of resizes) fn(size.cols, size.rows)
        })
        contents.ipc.on('terminal:close', (event) => {
            if (trusted(event) && alive()) win.close()
        })
        void win.loadURL(entry).catch(reject)
    })
}
