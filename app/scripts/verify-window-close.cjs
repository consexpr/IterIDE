const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const childProcess = require('node:child_process')
const ownedChildren = new Set()
const nativeSpawn = childProcess.spawn
childProcess.spawn = function (...args) {
    const child = nativeSpawn.apply(this, args)
    if (child.pid) {
        ownedChildren.add(child.pid)
        child.once('close', () => ownedChildren.delete(child.pid))
    }
    return child
}
const root = path.resolve(process.argv[2] || '')
const mode = process.argv[3] || 'save'
const marker = JSON.parse(fs.readFileSync(path.join(root, 'control', 'run-state.json'), 'utf8').replace(/^\uFEFF/, ''))
if (
    !marker.isolated ||
    path.resolve(marker.root) !== path.join(root, 'project') ||
    !['save', 'cancel', 'failure', 'plugin'].includes(mode)
)
    throw Error('Run this check through verify-isolated.ps1 in a fresh isolated workspace')
const sandbox = path.join(root, 'ui-' + mode + '-' + process.pid)
const roaming = path.join(sandbox, 'profile', 'Roaming')
const session = path.join(sandbox, 'profile', 'Session')
const cases = path.join(sandbox, 'cases')
const results = path.join(root, 'test-results')
for (const dir of [roaming, session, cases, results]) fs.mkdirSync(dir, { recursive: true })
process.env.ITER_STORE = path.join(sandbox, 'store')
process.env.ITER_CAPTURE = path.join(results, 'ui-' + mode + '.png')
process.env.ITER_CAPTURE_DELAY = '600000'
process.env.ITER_CAPTURE_KEEP = '1'
delete process.env.ITER_EVAL
app.setPath('appData', roaming)
app.setPath('userData', path.join(roaming, 'ITER'))
app.setPath('sessionData', session)
app.disableHardwareAcceleration()
BrowserWindow.prototype.show = function () {}
const output = path.join(results, 'ui-' + mode + '.json')
const source = path.join(cases, 'sample.cpp')
const original = 'int main(){return 0;}\n'
const changed = 'int main(){return 7;}\n'
fs.writeFileSync(source, original)
let pluginServer
if (mode === 'plugin') {
    pluginServer = require('node:http').createServer((_req, response) =>
        response.end('<!doctype html><title>Isolated plugin</title>')
    )
    global.__iterSmokeURL = new Promise((resolve) =>
        pluginServer.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + pluginServer.address().port))
    )
    const plugin = path.join(roaming, 'ITER', 'plugins', 'shutdown-smoke')
    fs.mkdirSync(plugin, { recursive: true })
    fs.writeFileSync(
        path.join(plugin, 'iter-plugin.json'),
        JSON.stringify({ id: 'shutdown-smoke', name: 'Shutdown smoke', version: '1.0.0', main: 'index.cjs' })
    )
    fs.writeFileSync(
        path.join(plugin, 'index.cjs'),
        'exports.activate=async host=>{await host.openWindow(await global.__iterSmokeURL,{show:false})}'
    )
}
let finished = false,
    testId
function fail(error) {
    if (finished) return
    finished = true
    fs.writeFileSync(
        output,
        JSON.stringify({ mode, ok: false, error: String((error && error.stack) || error) }, null, 2)
    )
    console.error('SMOKE_FAIL', mode, error)
    for (const pid of ownedChildren)
        childProcess.spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
            timeout: 5000
        })
    pluginServer?.close()
    app.exit(1)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
setTimeout(() => fail(Error('Isolated window-close verification timed out')), 45000)
app.on('browser-window-created', (_event, win) => {
    win.webContents.once('did-finish-load', async () => {
        if (!win.webContents.getURL().endsWith('/renderer/index.html')) return
        try {
            for (let n = 0; ; n++) {
                if (await win.webContents.executeJavaScript('Boolean(window.__nv?.store.get().ready)')) break
                if (n > 150) throw Error('Renderer did not become ready')
                await sleep(100)
            }
            const userData = app.getPath('userData')
            if (!userData.startsWith(sandbox + path.sep) || !process.env.ITER_STORE.startsWith(sandbox + path.sep))
                throw Error('Isolation path check failed')
            if (mode === 'plugin') {
                for (let n = 0; BrowserWindow.getAllWindows().length < 2; n++) {
                    if (n > 100) throw Error('Isolated plugin window did not open')
                    await sleep(50)
                }
            }
            const setup = [
                '(async () => {',
                'const settings = await iter.settings.set({ autoSave: ' + (mode !== 'cancel') + ' });',
                '__nv.store.set({ settings });',
                'await __nv.files.openFile(' + JSON.stringify(source) + ');',
                'await __nv.tests.addTest("old input\\n","old answer\\n");',
                'const f = __nv.store.get().files.find(f => f.path === ' + JSON.stringify(source) + ');',
                'f.model.setValue(' + JSON.stringify(changed) + ');',
                'const id = f.tests[0].id;',
                '__nv.tests.editTest(id, {input:"new input\\n",answer:"new answer\\n"});',
                mode === 'cancel' ? 'window.confirm = () => false;' : '',
                'return id; })()'
            ].join('\n')
            testId = await win.webContents.executeJavaScript(setup)
            if (mode === 'failure') {
                fs.renameSync(source, source + '.before')
                fs.mkdirSync(source)
            }
            if (mode === 'cancel' || mode === 'failure') {
                win.close()
                await sleep(800)
                if (win.isDestroyed()) throw Error('Window closed despite cancellation/save failure')
                const state = await win.webContents.executeJavaScript(
                    '({closing:__nv.store.get().closing,dirty:__nv.store.get().files[0].dirty})'
                )
                if (state.closing || !state.dirty) throw Error('Failed close did not restore usable dirty editor')
                if (mode === 'cancel') {
                    if (fs.readFileSync(source, 'utf8') !== original)
                        throw Error('Cancelled close unexpectedly saved code')
                    await win.webContents.executeJavaScript('window.confirm = () => true; undefined')
                } else {
                    fs.rmdirSync(source)
                    fs.renameSync(source + '.before', source)
                }
            }
            win.once('closed', () => {
                try {
                    const expected = mode === 'cancel' ? original : changed
                    if (fs.readFileSync(source, 'utf8') !== expected)
                        throw Error('Closed window did not preserve the expected source bytes')
                    if (BrowserWindow.getAllWindows().some((window) => !window.isDestroyed()))
                        throw Error('Plugin window survived application shutdown')
                    const id = fs.readFileSync(source + ':iter.id', 'utf8').trim()
                    const problem = path.join(process.env.ITER_STORE, 'problems', id)
                    if (fs.readFileSync(path.join(problem, 'tests', testId + '.in'), 'utf8') !== 'new input\n')
                        throw Error('Pending test input was not flushed before close')
                    if (fs.readFileSync(path.join(problem, 'tests', testId + '.ans'), 'utf8') !== 'new answer\n')
                        throw Error('Pending test answer was not flushed before close')
                    finished = true
                    fs.writeFileSync(
                        output,
                        JSON.stringify(
                            {
                                mode,
                                ok: true,
                                userData,
                                store: process.env.ITER_STORE,
                                sourceSaved: mode !== 'cancel',
                                pendingTestsFlushed: true
                            },
                            null,
                            2
                        )
                    )
                    console.log('SMOKE_OK', mode)
                    pluginServer?.close()
                    app.exit(0)
                } catch (error) {
                    fail(error)
                }
            })
            win.close()
        } catch (error) {
            fail(error)
        }
    })
})
require(path.join(root, 'project', 'app', 'out', 'main', 'index.js'))
