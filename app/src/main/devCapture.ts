// Dev-only harness: `ITER_CAPTURE=out.png [ITER_EVAL="js"] [ITER_CAPTURE_DELAY=ms] electron .`
// runs optional JS in the renderer, screenshots the window, then quits. Used to check UI changes headlessly.
// Progress and renderer console go to `<out>.log` (stdout is unreliable when the process is killed).
import { app, ipcMain, type BrowserWindow } from 'electron'
import { appendFileSync, writeFileSync } from 'node:fs'
import { trustedSender } from './security'

export function maybeCapture(win: BrowserWindow, rendererEntry: string): void {
    const out = process.env['ITER_CAPTURE']
    if (!out) return
    const delay = Number(process.env['ITER_CAPTURE_DELAY'] ?? 2500)
    const log = (...a: unknown[]): void => appendFileSync(`${out}.log`, `${a.map(String).join(' ')}\n`)
    // extra screenshots on demand from ITER_EVAL scripts: `await iter.dev.capture('x.png')`
    ipcMain.handle('dev:capture', async (event, file: string) => {
        if (!trustedSender(event, win.webContents, rendererEntry)) throw new Error('Untrusted IPC sender')
        writeFileSync(file, (await win.webContents.capturePage()).toPNG())
        log('captured', file)
    })
    win.webContents.on('console-message', (e) => log('[renderer]', (e as unknown as { message: string }).message))
    win.webContents.on('render-process-gone', (_e, d) => log('[renderer gone]', d.reason))
    win.webContents.once('did-finish-load', () => {
        log('loaded')
        setTimeout(async () => {
            try {
                const js = process.env['ITER_EVAL']
                if (js) {
                    await win.webContents.executeJavaScript(`(async () => { ${js} })()`)
                    await new Promise((r) => setTimeout(r, Number(process.env['ITER_EVAL_WAIT'] ?? 1500)))
                }
                const img = await win.webContents.capturePage()
                writeFileSync(out, img.toPNG())
                log('captured')
            } catch (e) {
                log('error', e)
            } finally {
                if (process.env['ITER_CAPTURE_KEEP'] !== '1') app.quit()
            }
        }, delay)
    })
}
