// Real Electron smoke test. All files are synthetic and every window stays hidden.
const { app, BrowserWindow, net, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const appRoot = path.resolve(__dirname, '..')
const parent = path.join(appRoot, '.cache', 'audit')
fs.mkdirSync(parent, { recursive: true })
const root = fs.mkdtempSync(path.join(parent, 'security-smoke-'))
process.env.ITER_DATA_DIR = path.join(root, 'runtime')
process.env.ITER_CAPTURE = path.join(root, 'editor.png')
process.env.ITER_CAPTURE_DELAY = '600000'
process.env.ITER_CAPTURE_KEEP = '1'
for (const key of ['ITER_STORE', 'ITER_EVAL', 'ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE']) delete process.env[key]
app.setAppPath(appRoot)
app.disableHardwareAcceleration()
BrowserWindow.prototype.show = function () {}
const opened = []
shell.openExternal = async (url) => {
    opened.push(url)
}
const report = { ok: false, root, checks: {} }
let finished = false
const assert = (value, message) => {
    if (!value) throw Error(message)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function finish(error) {
    if (finished) return
    finished = true
    clearTimeout(deadline)
    report.ok = !error
    if (error) report.error = String(error.stack || error)
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2))
    console.log(report.ok ? 'SECURITY_SMOKE_OK' : 'SECURITY_SMOKE_FAIL', path.join(root, 'result.json'))
    app.exit(report.ok ? 0 : 1)
}
const deadline = setTimeout(() => finish(Error('Security smoke timed out')), 60000)
process.on('uncaughtException', finish)
process.on('unhandledRejection', finish)
let started = false
app.on('browser-window-created', (_event, win) => {
    if (started) return
    started = true
    win.webContents.setBackgroundThrottling(false)
    win.webContents.once('did-finish-load', async () => {
        try {
            const evaluate = (script) => win.webContents.executeJavaScript(script)
            for (let i = 0; !(await evaluate('Boolean(window.__nv?.store.get().ready)')); i++) {
                if (i > 150) throw Error('Sandboxed preload did not initialize the editor')
                await sleep(100)
            }
            const preferences = win.webContents.getLastWebPreferences()
            assert(
                preferences.sandbox && preferences.contextIsolation && !preferences.nodeIntegration,
                'Renderer sandbox is disabled'
            )
            assert(
                await evaluate('typeof require === "undefined" && typeof process === "undefined"'),
                'Node leaked into the renderer'
            )
            report.checks.sandbox = true
            const settings = await evaluate('iter.settings.get()')
            assert(typeof settings.theme === 'string', 'Trusted main-frame IPC stopped working')
            const rejected = await evaluate(
                `iter.app.openExternal('file:///C:/Windows/System32/calc.exe').then(() => false, () => true)`
            )
            assert(rejected && opened.length === 0, 'A file URL reached the system shell')
            await evaluate(`iter.app.openExternal('https://example.invalid/problem')`)
            assert(
                opened.length === 1 && opened[0] === 'https://example.invalid/problem',
                'HTTP link dispatch regressed'
            )
            report.checks.externalLinks = true

            const page = path.join(root, 'foreign.html')
            fs.writeFileSync(page, '<!doctype html><title>Foreign frame</title>')
            const foreign = new BrowserWindow({
                show: false,
                webPreferences: {
                    preload: path.join(appRoot, 'out/preload/index.js'),
                    sandbox: true,
                    contextIsolation: true
                }
            })
            await foreign.loadFile(page)
            const denied = await foreign.webContents.executeJavaScript(
                'iter.settings.get().then(() => false, error => String(error).includes("Untrusted IPC sender"))'
            )
            assert(denied, 'Foreign window obtained editor IPC privileges')
            foreign.destroy()
            report.checks.foreignWindowRejected = true

            const initialUrl = win.webContents.getURL()
            await evaluate(`location.href = ${JSON.stringify(require('node:url').pathToFileURL(page).href)}; undefined`)
            await sleep(200)
            assert(win.webContents.getURL() === initialUrl, 'Editor navigated to an untrusted document')
            report.checks.navigation = true

            const themes = path.join(app.getPath('userData'), 'themes')
            const outside = path.join(root, 'outside')
            fs.mkdirSync(outside)
            fs.writeFileSync(path.join(outside, 'private.css'), 'synthetic-private-data')
            fs.writeFileSync(path.join(themes, 'allowed.css'), 'body{}')
            fs.symlinkSync(outside, path.join(themes, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
            assert((await net.fetch('iter://themes/allowed.css')).status === 200, 'Valid theme asset is inaccessible')
            assert(
                (await net.fetch('iter://themes/escape/private.css')).status === 404,
                'Theme junction escaped its root'
            )
            assert(
                (await net.fetch('iter://fonts/settings.json')).status === 404,
                'Font endpoint served a non-font file'
            )
            report.checks.userAssets = true

            const source = path.join(root, 'sample.cpp')
            const code = '#include <iostream>\nint main(){int x;std::cin>>x;std::cout<<x*2;}'
            await evaluate(`(async () => {
        await iter.fs.writeText(${JSON.stringify(source)}, ${JSON.stringify(code)});
        await __nv.files.openFile(${JSON.stringify(source)});
        await __nv.tests.addTest('21', '42');
      })()`)
            const events = await evaluate(`new Promise((resolve, reject) => {
        const events = [], stop = iter.judge.onEvent(event => {
          events.push(event); if (event.type === 'done') { stop(); resolve(events); }
        });
        iter.judge.run({sourcePath:${JSON.stringify(source)}, source:${JSON.stringify(code)}}).catch(error => {stop(); reject(error)});
      })`)
            assert(
                events.some((event) => event.type === 'test-done' && event.result.verdict === 'AC'),
                'Real compiler/judge roundtrip failed'
            )
            report.checks.compileAndJudge = true
            await sleep(300) // Let the hidden window paint the editor and verdict before the evidence capture.
            const editor = await evaluate(`({
        activePath: __nv.store.get().activePath,
        source: __nv.editorRef.editor.getModel()?.getValue(),
        tab: document.querySelector('.nv-tab.is-active .nv-tab-name')?.textContent
      })`)
            assert(
                editor.activePath === source && editor.source === code && editor.tab?.includes('sample.cpp'),
                'Editor model or active tab did not update'
            )
            report.checks.editorState = true
            fs.writeFileSync(path.join(root, 'editor.png'), (await win.webContents.capturePage()).toPNG())
            win.once('closed', () => {
                report.checks.gracefulClose = true
                finish()
            })
            win.close()
        } catch (error) {
            finish(error)
        }
    })
})
require(path.join(appRoot, 'out/main/index.js'))
