// Run with the project's Electron executable after `npm run build`.
// All fixtures, profiles, compiler caches, logs and results stay in the workspace sandbox.
const fs = require('node:fs')
const path = require('node:path')
const childProcess = require('node:child_process')

const appRoot = path.resolve(process.argv[2] || path.join(__dirname, '..'))
const sandboxParent = path.resolve(appRoot, '..', 'sandbox')
if (path.basename(appRoot).toLowerCase() !== 'app') {
    throw Error('Release smoke requires the ITER app checkout')
}
const sandbox = path.join(sandboxParent, `release-smoke-${Date.now()}-${process.pid}`)
fs.mkdirSync(sandbox, { recursive: true })
const temporary = path.join(sandbox, 'tmp')
const profile = path.join(sandbox, 'profile')
const cases = path.join(sandbox, 'cases')
const results = path.join(sandbox, 'results')
for (const directory of [
    temporary,
    profile,
    cases,
    results,
    path.join(profile, 'Roaming'),
    path.join(profile, 'Local')
]) {
    fs.mkdirSync(directory, { recursive: true })
}
Object.assign(process.env, {
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    APPDATA: path.join(profile, 'Roaming'),
    LOCALAPPDATA: path.join(profile, 'Local'),
    ITER_DATA_DIR: path.join(sandbox, 'runtime'),
    ITER_CAPTURE: path.join(results, 'editor.png'),
    ITER_CAPTURE_DELAY: '600000',
    ITER_CAPTURE_KEEP: '1'
})
for (const name of ['ITER_EVAL', 'ITER_STORE', 'ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE'])
    delete process.env[name]

const { app, BrowserWindow, ipcMain } = require('electron')
const output = path.join(results, 'release-smoke.json')
const logFile = path.join(results, 'release-smoke.log')
const evidence = { sandbox, appRoot, checks: {} }
const log = (message) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`)
const assert = (condition, message) => {
    if (!condition) throw Error(message)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const insideSandbox = (target) => {
    const relative = path.relative(sandbox, path.resolve(target))
    return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}
const until = async (check, message, timeout = 15000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
        const value = await check()
        if (value) return value
        await sleep(100)
    }
    throw Error(message)
}

// Observe the actual launch and IPC results while preserving their implementation.
const ownedChildren = new Set()
const launches = []
const terminalAcks = new Map()
const terminalOutput = new Map()
const nativeSpawn = childProcess.spawn
childProcess.spawn = function (...args) {
    const child = nativeSpawn.apply(this, args)
    if (child.pid) {
        ownedChildren.add(child.pid)
        launches.push({
            command: String(args[0]),
            args: args[1],
            windowsHide: args[2]?.windowsHide,
            detached: args[2]?.detached,
            shell: args[2]?.shell,
            pid: child.pid
        })
        child.once('close', () => ownedChildren.delete(child.pid))
    }
    return child
}
const terminalCalls = []
const stopCalls = []
const importerCalls = []
const nativeHandle = ipcMain.handle
ipcMain.handle = function (channel, handler) {
    if (channel.startsWith('importer:')) {
        return nativeHandle.call(this, channel, (...args) => {
            importerCalls.push(channel)
            return handler(...args)
        })
    }
    if (channel === 'terminal:run') {
        return nativeHandle.call(this, channel, async (...args) => {
            const request = args[1]
            const call = { sourcePath: request?.sourcePath, operationId: request?.operationId, source: request?.source }
            terminalCalls.push(call)
            try {
                call.result = await handler(...args)
                return call.result
            } catch (error) {
                call.error = String(error)
                throw error
            }
        })
    }
    if (channel === 'terminal:stop') {
        return nativeHandle.call(this, channel, async (...args) => {
            const call = { runId: args[1], complete: false }
            stopCalls.push(call)
            await handler(...args)
            call.complete = true
        })
    }
    return nativeHandle.call(this, channel, handler)
}

app.setAppPath(appRoot)
app.disableHardwareAcceleration()
BrowserWindow.prototype.show = function () {}
const original = 'int main() { return 0; }\n'
const sourcePath = path.join(cases, 'terminal-smoke.cpp')
const marker = path.join(cases, 'terminal-started.txt')
const edited = [
    '#include <fstream>',
    '#include <iostream>',
    '#include <chrono>',
    '#include <thread>',
    'int main() {',
    `  std::ofstream(${JSON.stringify(marker.replaceAll('\\', '/'))}) << "current-buffer-ran";`,
    '  std::cout << "ITER terminal smoke: enter an integer: " << std::flush;',
    '  std::this_thread::sleep_for(std::chrono::seconds(30));',
    '  int value = 0;',
    '  std::cin >> value;',
    '  return 0;',
    '}',
    ''
].join('\n')
fs.writeFileSync(sourcePath, original)
fs.writeFileSync(path.join(cases, '01.in'), '7\n')
fs.writeFileSync(path.join(cases, '01.out'), '7\n')
fs.writeFileSync(path.join(cases, 'terminal-smoke.in'), '8\n')
fs.writeFileSync(path.join(cases, 'terminal-smoke.out'), '8\n')

let finished = false
let activeWindow
const cleanup = async () => {
    if (activeWindow && !activeWindow.isDestroyed()) {
        for (const call of terminalCalls) {
            if (!call.operationId) continue
            await activeWindow.webContents
                .executeJavaScript(`iter.terminal.stop(${JSON.stringify(call.operationId)})`)
                .catch(() => {})
        }
        await activeWindow.webContents.executeJavaScript('iter.lsp.stop()').catch(() => {})
    }
    for (const pid of [...ownedChildren]) {
        childProcess.spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
            timeout: 5000
        })
    }
}
const finish = async (error) => {
    if (finished) return
    finished = true
    clearTimeout(timeout)
    if (error) {
        evidence.error = String(error.stack || error)
        log(evidence.error)
    }
    await cleanup()
    evidence.ok = !error
    evidence.completedUtc = new Date().toISOString()
    fs.writeFileSync(output, JSON.stringify(evidence, null, 2))
    console.log(error ? 'RELEASE_SMOKE_FAIL' : 'RELEASE_SMOKE_OK', output)
    app.exit(error ? 1 : 0)
}
const timeout = setTimeout(() => void finish(Error('Release smoke timed out')), 120000)
process.on('uncaughtException', (error) => void finish(error))
process.on('unhandledRejection', (error) => void finish(error instanceof Error ? error : Error(String(error))))

app.on('browser-window-created', (_event, window) => {
    const contents = window.webContents
    contents.ipc.on('terminal:ack', () => {
        terminalAcks.set(window.id, (terminalAcks.get(window.id) || 0) + 1)
    })
    const send = contents.send
    contents.send = function (channel, ...args) {
        if (channel === 'terminal:data') {
            const text = (terminalOutput.get(window.id) || '') + Buffer.from(args[0]).toString('utf8')
            terminalOutput.set(window.id, text.slice(-8192))
        }
        return send.call(this, channel, ...args)
    }
    window.webContents.once('did-finish-load', async () => {
        if (!window.webContents.getURL().endsWith('/renderer/index.html') || activeWindow) return
        activeWindow = window
        const evaluate = (script) => window.webContents.executeJavaScript(script)
        try {
            await until(() => evaluate('Boolean(window.__nv?.store.get().ready)'), 'Renderer did not become ready')
            log('Renderer ready')
            const paths = Object.fromEntries(
                ['userData', 'sessionData', 'temp', 'logs', 'crashDumps'].map((name) => [name, app.getPath(name)])
            )
            paths.store = process.env.ITER_STORE
            paths.environmentTemp = process.env.TEMP
            paths.osTemp = require('node:os').tmpdir()
            for (const [name, target] of Object.entries(paths)) {
                assert(insideSandbox(target), `${name} escaped the workspace sandbox: ${target}`)
            }
            evidence.checks.paths = paths

            await evaluate(`(async () => {
        const settings = await iter.settings.set({ autoSave: false });
        __nv.store.set({ settings });
        await __nv.files.openFile(${JSON.stringify(sourcePath)});
      })()`)
            // Leave enough time for a fire-and-forget directory import to reveal itself.
            await sleep(1200)
            const unopened = await evaluate(`(async () => {
        const f = __nv.store.get().files.find(file => file.path === ${JSON.stringify(sourcePath)});
        return { tests: f.tests.length, persistedTests: (await iter.problem.readTests(f.path)).length,
          dialog: __nv.store.get().dialog?.kind || null };
      })()`)
            assert(
                unopened.tests === 0 && unopened.persistedTests === 0,
                'Opening source imported neighboring .in/.out files'
            )
            assert(
                unopened.dialog === null && importerCalls.length === 0,
                'Opening source invoked an automatic directory import'
            )
            evidence.checks.noAutomaticImport = { ...unopened, importerCalls: importerCalls.length }
            log('Neighboring input/output files were not imported')

            await evaluate(`(() => {
        const f = __nv.store.get().files.find(file => file.path === ${JSON.stringify(sourcePath)});
        f.model.setValue(${JSON.stringify(edited)});
        window.__releaseModel = f.model;
        const logo = document.querySelector('button.nv-brand');
        if (!logo) throw Error('Clickable titlebar logo is missing');
        if (getComputedStyle(logo).getPropertyValue('-webkit-app-region') !== 'no-drag') throw Error('Logo is still part of the draggable titlebar');
        logo.click();
      })()`)
            await until(
                () =>
                    evaluate('Boolean(document.querySelector(".nv-welcome")) && __nv.store.get().activePath === null'),
                'Logo did not display the homepage'
            )
            const home = await evaluate(`(() => {
        const s = __nv.store.get(), f = s.files.find(file => file.path === ${JSON.stringify(sourcePath)});
        return { activePath: s.activePath, files: s.files.length, dirty: f?.dirty,
          preservedModel: f?.model === window.__releaseModel && !f.model.isDisposed(),
          preservedSource: f?.model.getValue() === ${JSON.stringify(edited)},
          editorDetached: __nv.editorRef.editor.getModel() === null };
      })()`)
            assert(
                home.activePath === null &&
                    home.files === 1 &&
                    home.dirty &&
                    home.preservedModel &&
                    home.preservedSource &&
                    home.editorDetached,
                'Homepage navigation lost the unsaved editor state'
            )
            assert(
                fs.readFileSync(sourcePath, 'utf8') === original,
                'Homepage navigation unexpectedly saved the source'
            )
            fs.writeFileSync(path.join(results, 'home.png'), (await window.webContents.capturePage()).toPNG())
            evidence.checks.home = home
            log('Logo homepage navigation preserved the unsaved model')

            await evaluate(`__nv.files.activate(${JSON.stringify(sourcePath)})`)
            await until(
                () =>
                    evaluate(
                        'Boolean([...document.querySelectorAll("button")].find(button => button.textContent.trim() === "终端运行" && !button.disabled))'
                    ),
                'Terminal run button is missing or disabled without tests'
            )
            await evaluate(`(() => {
        const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === '终端运行');
        if (!/Ctrl[ +]*F5/.test(button.title)) throw Error('Terminal run shortcut is missing');
        window.__releaseTerminalExits = [];
        iter.terminal.onExit(event => window.__releaseTerminalExits.push(event.runId));
        button.click();
      })()`)
            const call = await until(
                () => terminalCalls.find((call) => call.result || call.error),
                'Terminal IPC did not finish',
                60000
            )
            assert(
                !call.error && call.result?.compile?.ok && call.result.launched,
                `Terminal compile/launch failed: ${call.error || JSON.stringify(call.result)}`
            )
            assert(
                call.sourcePath === sourcePath && call.source === edited,
                'Terminal did not compile the current unsaved editor snapshot'
            )
            assert(call.result.runId === call.operationId, 'Terminal run result did not preserve its operation id')
            assert(insideSandbox(call.result.compile.exe), 'Terminal compiled outside the isolated store')
            await until(
                () => fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === 'current-buffer-ran',
                'The real terminal did not execute the compiled program'
            )
            assert(
                fs.readFileSync(sourcePath, 'utf8') === original,
                'Terminal run unexpectedly saved the source with auto-save disabled'
            )
            const terminalLaunches = launches.filter(
                (launch) => launch.windowsHide === true && launch.args?.[0] === call.result.compile.exe
            )
            assert(
                terminalLaunches.some(
                    (launch) => launch.detached && launch.shell === false && insideSandbox(launch.command)
                ),
                'No isolated pseudo-console helper was launched'
            )
            const terminalWindow = await until(
                () =>
                    BrowserWindow.getAllWindows().find((candidate) =>
                        /\/renderer\/terminal\.html(?:\?|$)/.test(candidate.webContents.getURL())
                    ),
                'The terminal renderer window was not created'
            )
            const terminalPreferences = terminalWindow.webContents.getLastWebPreferences()
            assert(
                terminalPreferences.sandbox &&
                    terminalPreferences.contextIsolation &&
                    !terminalPreferences.nodeIntegration,
                'The terminal renderer lost its isolated preload boundary'
            )
            await until(
                () =>
                    (terminalAcks.get(terminalWindow.id) || 0) > 0 &&
                    (terminalOutput.get(terminalWindow.id) || '').includes('ITER terminal smoke: enter an integer:'),
                'Terminal output was not consumed and acknowledged by xterm'
            )
            evidence.checks.terminal = {
                runId: call.result.runId,
                compiled: call.result.compile.ok,
                exe: call.result.compile.exe,
                launched: call.result.launched,
                currentBufferExecuted: true,
                withoutTests: true,
                sourceDiskUnchanged: true,
                rendererAcknowledgedOutput: true,
                nativeLaunches: terminalLaunches
            }
            fs.writeFileSync(path.join(results, 'terminal.png'), (await window.webContents.capturePage()).toPNG())
            log('Terminal button compiled and ran the current buffer without tests')

            await until(
                () => evaluate('Boolean(document.querySelector("button[title=\\"停止终端运行\\"]"))'),
                'Terminal stop button did not appear'
            )
            await evaluate('document.querySelector("button[title=\\"停止终端运行\\"]").click()')
            await until(
                () => stopCalls.some((stop) => stop.runId === call.result.runId && stop.complete),
                'Terminal stop IPC did not finish'
            )
            await until(
                () => evaluate(`window.__releaseTerminalExits.includes(${JSON.stringify(call.result.runId)})`),
                'Terminal exit event was not delivered'
            )
            await until(
                () =>
                    evaluate(
                        `(() => { const f = __nv.store.get().files.find(file => file.path === ${JSON.stringify(sourcePath)}); return f && f.terminalRunId === null && !f.terminalPending; })()`
                    ),
                'Stopping the terminal did not clear its state'
            )
            assert(
                terminalLaunches.every((launch) => !ownedChildren.has(launch.pid)),
                'Terminal stop left a native host running'
            )
            evidence.checks.terminal.stopped = true
            log('Terminal stop button cleared the run state')
            await finish()
        } catch (error) {
            await finish(error)
        }
    })
})
log(`Starting built application: ${appRoot}`)
require(path.join(appRoot, 'out', 'main', 'index.js'))
