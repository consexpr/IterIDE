// Targeted real-window checks. Synthetic data, hidden windows, and stubbed native dialogs only.
const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const mode = process.argv.find((value) => ['boundary', 'startup', 'crash'].includes(value)) || 'boundary'
if (!['boundary', 'startup', 'crash'].includes(mode)) throw Error('Unknown recovery verification mode')
const appRoot = path.resolve(__dirname, '..')
const parent = path.join(appRoot, '.cache', 'audit')
fs.mkdirSync(parent, { recursive: true })
const root = fs.mkdtempSync(path.join(parent, `recovery-${mode}-`))
process.env.ITER_DATA_DIR = path.join(root, 'runtime')
process.env.ITER_CAPTURE = path.join(root, 'screen.png')
process.env.ITER_CAPTURE_DELAY = '600000'
process.env.ITER_CAPTURE_KEEP = '1'
for (const key of ['ITER_STORE', 'ITER_EVAL', 'ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE']) delete process.env[key]
app.setAppPath(appRoot)
app.disableHardwareAcceleration()
BrowserWindow.prototype.show = function () {}
const report = { mode, ok: false, checks: {} }
let relaunches = 0,
    overwrite = 0,
    finished = false
app.relaunch = () => {
    relaunches++
}
dialog.showMessageBox = async (_window, options) => {
    if (options.buttons.includes('覆盖磁盘文件')) return { response: overwrite }
    report.checks.nativeRecovery = true
    return { response: mode === 'crash' ? 0 : 1 }
}
if (mode === 'startup') {
    const handle = ipcMain.handle.bind(ipcMain)
    ipcMain.handle = (channel, callback) =>
        handle(
            channel,
            channel === 'settings:get'
                ? () => {
                      throw Error('Synthetic settings failure')
                  }
                : callback
        )
}
const sessionFile = path.join(root, 'runtime', 'userData', 'session.json')
const previous = JSON.stringify({ version: 1, active: null, tabs: [] })
fs.mkdirSync(path.dirname(sessionFile), { recursive: true })
fs.writeFileSync(sessionFile, previous)
const assert = (condition, message) => {
    if (!condition) throw Error(message)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check) {
    for (let i = 0; i < 200; i++) {
        if (await check()) return
        await sleep(50)
    }
    throw Error('Recovery check did not settle')
}
function finish(error) {
    if (finished) return
    finished = true
    clearTimeout(deadline)
    report.ok = !error
    if (error) report.error = String(error.stack || error)
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2))
    console.log(report.ok ? 'RECOVERY_OK' : 'RECOVERY_FAIL', mode, path.join(root, 'result.json'))
    app.exit(report.ok ? 0 : 1)
}
const deadline = setTimeout(() => finish(Error('Recovery smoke timed out')), 30000)
process.on('uncaughtException', finish)
process.on('unhandledRejection', finish)
let started = false
app.on('browser-window-created', (_event, win) => {
    if (started) return
    started = true
    win.webContents.setBackgroundThrottling(false)
    win.once('closed', () => {
        try {
            assert(mode !== 'crash' || relaunches === 1, 'Crash recovery did not request exactly one relaunch')
            report.checks.closed = true
            finish()
        } catch (error) {
            finish(error)
        }
    })
    win.webContents.once('did-finish-load', async () => {
        try {
            assert(app.getPath('userData') === path.dirname(sessionFile), 'Unexpected user profile')
            const evaluate = (script) => win.webContents.executeJavaScript(script)
            if (mode === 'startup') {
                await until(() => evaluate('!!document.querySelector(".nv-recovery")'))
                assert(fs.readFileSync(sessionFile, 'utf8') === previous, 'Failed startup replaced the prior session')
                await until(() =>
                    evaluate('document.querySelector(".nv-recovery").textContent.includes("保留上次会话")')
                )
                report.checks.startupFallback = true
                fs.writeFileSync(path.join(root, 'screen.png'), (await win.webContents.capturePage()).toPNG())
                win.close()
                return
            }
            await until(() => evaluate('!!window.__nv?.store.get().ready'))
            if (mode === 'crash') {
                report.checks.realRendererCrash = true
                win.webContents.forcefullyCrashRenderer()
                return
            }
            const source = path.join(root, 'solution.cpp')
            fs.writeFileSync(source, 'original')
            await evaluate(`__nv.files.openFile(${JSON.stringify(source)})`)
            const identity = fs.readFileSync(`${source}:iter.id`, 'utf8')
            await evaluate('__nv.store.get().files[0].model.setValue("saved edit")')
            fs.writeFileSync(source, 'external edit')
            assert(
                await evaluate('__nv.files.persistFile().then(()=>false,()=>true)'),
                'Background save ignored a conflict'
            )
            assert(
                await evaluate('__nv.files.saveFile().then(()=>false,()=>true)'),
                'Cancelled overwrite reported success'
            )
            assert(fs.readFileSync(source, 'utf8') === 'external edit', 'Conflict overwrote disk contents')
            overwrite = 1
            await evaluate('__nv.files.saveFile()')
            assert(fs.readFileSync(source, 'utf8') === 'saved edit', 'Confirmed save failed')
            assert(fs.readFileSync(`${source}:iter.id`, 'utf8') === identity, 'Saving lost the problem identity')
            report.checks.sourceSaving = true
            await evaluate(`__nv.store.get().files[0].model.setValue('unsaved recovery buffer');
                __nv.store.set({settings:{...__nv.store.get().settings,editor:null}})`)
            await until(() =>
                evaluate('!!document.querySelector(".nv-recovery")?.textContent.includes("当前编辑内容已保存")')
            )
            const recovered = JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
            assert(recovered.tabs[0].text === 'unsaved recovery buffer', 'Boundary recovery lost live model contents')
            report.checks.boundarySnapshot = true
            fs.writeFileSync(path.join(root, 'screen.png'), (await win.webContents.capturePage()).toPNG())
            await evaluate(
                'Array.from(document.querySelectorAll(".nv-recovery button")).find(b=>b.textContent==="退出").click()'
            )
        } catch (error) {
            finish(error)
        }
    })
})
require(path.join(appRoot, 'out/main/index.js'))
