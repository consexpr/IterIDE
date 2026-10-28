// Real Electron/IPC regression smoke. Run after `npm run build` with Electron.
// Profiles, fixtures, builds and reports stay in a fresh workspace sandbox.
const fs = require('node:fs')
const path = require('node:path')
const childProcess = require('node:child_process')
const appRoot = path.resolve(process.argv[2] || path.join(__dirname, '..'))
const sandbox = path.resolve(appRoot, '..', 'sandbox', `freopen-smoke-${Date.now()}-${process.pid}`)
const results = path.join(sandbox, 'results')
const cases = path.join(sandbox, 'cases')
for (const folder of [results, cases, 'tmp', 'profile/Roaming', 'profile/Local'].map((value) =>
    path.isAbsolute(value) ? value : path.join(sandbox, value)
)) {
    fs.mkdirSync(folder, { recursive: true })
}
Object.assign(process.env, {
    TEMP: path.join(sandbox, 'tmp'),
    TMP: path.join(sandbox, 'tmp'),
    TMPDIR: path.join(sandbox, 'tmp'),
    APPDATA: path.join(sandbox, 'profile', 'Roaming'),
    LOCALAPPDATA: path.join(sandbox, 'profile', 'Local'),
    ITER_DATA_DIR: path.join(sandbox, 'runtime'),
    ITER_CAPTURE: path.join(results, 'dev.png'),
    ITER_CAPTURE_DELAY: '600000',
    ITER_CAPTURE_KEEP: '1'
})
for (const name of ['ITER_STORE', 'ITER_EVAL', 'ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE'])
    delete process.env[name]
const { app, BrowserWindow, ipcMain } = require('electron')
app.setAppPath(appRoot)
app.disableHardwareAcceleration()
BrowserWindow.prototype.show = function () {}

const evidence = { appRoot, sandbox, checks: [], judged: [], debug: [] }
const output = path.join(results, 'freopen-smoke.json')
const log = (message) =>
    fs.appendFileSync(path.join(results, 'freopen-smoke.log'), `${new Date().toISOString()} ${message}\n`)
const assert = (condition, message) => {
    if (!condition) throw Error(message)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (check, message, duration = 20000) => {
    const deadline = Date.now() + duration
    while (Date.now() < deadline) {
        const result = await check()
        if (result) return result
        await sleep(100)
    }
    throw Error(message)
}
const insideSandbox = (value) => {
    const relative = path.relative(sandbox, path.resolve(value))
    return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)
}
const ownedChildren = new Set()
const spawn = childProcess.spawn
childProcess.spawn = function (...args) {
    const child = spawn.apply(this, args)
    if (child.pid) {
        ownedChildren.add(child.pid)
        child.once('close', () => ownedChildren.delete(child.pid))
    }
    return child
}
const judgeCalls = []
const debugCalls = []
const persistedIO = () => {
    const problems = path.join(process.env.ITER_STORE, 'problems')
    const directories = fs.readdirSync(problems, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    assert(directories.length === 1, 'Fresh fixture store should contain exactly one problem')
    return JSON.parse(fs.readFileSync(path.join(problems, directories[0].name, 'problem.json'), 'utf8')).fileIO
}
const handle = ipcMain.handle
ipcMain.handle = function (channel, handler) {
    const calls = channel === 'judge:run' ? judgeCalls : channel === 'debug:start' ? debugCalls : undefined
    return handle.call(
        this,
        channel,
        calls
            ? (...args) => {
                  calls.push({ ...args[1], fileIOBeforeDispatch: persistedIO() })
                  return handler(...args)
              }
            : handler
    )
}

const sourcePath = path.join(cases, 'freopen-smoke.cpp')
const original = 'int main() { return 0; }\n'
fs.writeFileSync(sourcePath, original)
const program = (mode = 'removed', stem = 'auto') => {
    const calls = [`  freopen("${stem}.in", "r", stdin);`, `  freopen("${stem}.out", "w", stdout);`]
    const redirect =
        mode === 'active'
            ? calls
            : mode === 'line'
              ? calls.map((line) => '//' + line)
              : mode === 'block'
                ? ['/*', ...calls, '*/']
                : mode === 'disabled'
                  ? ['#if 0', ...calls, '#endif']
                  : []
    return [
        '#include <cstdio>',
        'int main() {',
        ...redirect,
        '  int a = 0, b = 0;',
        '  if (scanf("%d%d", &a, &b) != 2) return 17;',
        '  printf("%d\\n", a + b);',
        '  return 0;',
        '}',
        ''
    ].join('\n')
}
const fstreamProgram = (input, answer) =>
    [
        '#include <fstream>',
        'int main() {',
        `  std::ifstream input(${JSON.stringify(input)});`,
        `  std::ofstream output(${JSON.stringify(answer)});`,
        '  int a = 0, b = 0;',
        '  if (!(input >> a >> b)) return 17;',
        '  output << a + b << "\\n";',
        '  return 0;',
        '}',
        ''
    ].join('\n')

let mainWindow,
    finished = false
const finish = async (error) => {
    if (finished) return
    finished = true
    clearTimeout(timeout)
    if (error) {
        evidence.error = String(error.stack || error)
        log(evidence.error)
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
        await mainWindow.webContents
            .executeJavaScript(
                `(async () => {
      await __nv.debug.stopDebug(); await __nv.judge.stopRun(${JSON.stringify(sourcePath)}); await iter.lsp.stop();
    })()`
            )
            .catch(() => {})
    }
    for (const pid of [...ownedChildren])
        childProcess.spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
            windowsHide: true,
            timeout: 5000,
            stdio: 'ignore'
        })
    evidence.ok = !error
    evidence.completedUtc = new Date().toISOString()
    fs.writeFileSync(output, JSON.stringify(evidence, null, 2))
    console.log(error ? 'FREOPEN_SMOKE_FAIL' : 'FREOPEN_SMOKE_OK', output)
    app.exit(error ? 1 : 0)
}
const timeout = setTimeout(() => void finish(Error('Freopen regression smoke timed out')), 180000)
process.on('uncaughtException', (error) => void finish(error))
process.on('unhandledRejection', (error) => void finish(error instanceof Error ? error : Error(String(error))))

app.on('browser-window-created', (_event, window) => {
    window.webContents.once('did-finish-load', async () => {
        if (mainWindow || !window.webContents.getURL().endsWith('/renderer/index.html')) return
        mainWindow = window
        const evaluate = (expression) => window.webContents.executeJavaScript(expression)
        const setSource = (code) =>
            evaluate(
                `__nv.store.get().files.find(file => file.path === ${JSON.stringify(sourcePath)}).model.setValue(${JSON.stringify(code)})`
            )
        const readIO = () =>
            evaluate(`(async () => {
      const f = __nv.store.get().files.find(file => file.path === ${JSON.stringify(sourcePath)});
      const persisted = await iter.problem.load(f.path);
      return { state: f.problem.fileIO, persisted: persisted.fileIO, dirty: f.dirty };
    })()`)
        const requireIO = (value, enabled, origin, stem) => {
            for (const [kind, io] of Object.entries({ state: value.state, persisted: value.persisted })) {
                assert(
                    io.enabled === enabled && io.origin === origin,
                    `${kind} file IO mismatch: ${JSON.stringify(io)}`
                )
                if (stem)
                    assert(
                        io.input === `${stem}.in` && io.output === `${stem}.out`,
                        `${kind} did not adopt the current freopen names`
                    )
            }
        }
        const runCase = async (name, code, expected, autosave = false) => {
            await setSource(code)
            const before = judgeCalls.length
            await evaluate(`__nv.judge.runTests(undefined, ${JSON.stringify(sourcePath)})`)
            assert(judgeCalls.length === before + 1, `${name}: renderer did not dispatch one real judge operation`)
            const req = judgeCalls[before]
            assert(req.source === code, `${name}: judge received stale source bytes`)
            requireIO(
                { state: req.fileIOBeforeDispatch, persisted: req.fileIOBeforeDispatch },
                expected.enabled,
                expected.origin || 'freopen',
                expected.stem
            )
            const done = await until(
                () =>
                    evaluate(
                        `window.__freopenJudgeEvents.find(event => event.type === 'done' && event.runId === ${JSON.stringify(req.operationId)}) || null`
                    ),
                `${name}: judge did not finish`,
                45000
            )
            const state = await evaluate(`(() => {
        const f = __nv.store.get().files.find(file => file.path === ${JSON.stringify(sourcePath)});
        return { verdict: f.lastVerdict, results: Object.values(f.results), compile: f.compile };
      })()`)
            const verdict = expected.verdict || 'AC'
            assert(
                done.summary.verdict === verdict &&
                    done.summary.total === 1 &&
                    done.summary.passed === (verdict === 'AC' ? 1 : 0) &&
                    state.verdict === verdict,
                `${name}: expected ${verdict}, received ${JSON.stringify({ done, state })}`
            )
            assert(
                state.results.length === 1 && state.results[0].output.trim() === '42',
                `${name}: program output mismatch`
            )
            const io = await readIO()
            requireIO(io, expected.enabled, expected.origin || 'freopen', expected.stem)
            assert(
                fs.readFileSync(sourcePath, 'utf8') === (autosave ? code : original),
                `${name}: source save boundary mismatch`
            )
            evidence.judged.push({
                name,
                verdict,
                output: state.results[0].output,
                fileIO: io.persisted,
                persistedBeforeDispatch: true,
                currentBuffer: true,
                sourceSaved: autosave
            })
            log(`${name}: ${verdict}, file IO ${io.persisted.enabled ? 'on' : 'off'} (${io.persisted.origin})`)
            return io
        }
        const openIOPanel = async () => {
            await evaluate('__nv.store.set({ islandOpen: true })')
            await until(
                () => evaluate('Boolean(document.querySelector(".nvi-io input[type=checkbox]"))'),
                'File IO settings did not mount'
            )
        }
        const toggleIO = async () => {
            await openIOPanel()
            await evaluate('document.querySelector(".nvi-io input[type=checkbox]").click()')
            await evaluate(`__nv.tests.flushProblemWrites(${JSON.stringify(sourcePath)})`)
        }
        const detectIO = async () => {
            await openIOPanel()
            await evaluate(`(() => {
        const button = [...document.querySelectorAll('.nvi-io button')].find(button => button.textContent.trim() === '识别');
        if (!button) throw Error('Explicit file IO detection button is missing');
        button.click();
      })()`)
            await evaluate(`__nv.tests.flushProblemWrites(${JSON.stringify(sourcePath)})`)
            await until(
                async () => (await readIO()).persisted.origin === 'freopen',
                'Explicit detection did not return to code management'
            )
        }
        const debugCase = async (name, code, enabled, stem) => {
            await evaluate('__nv.debug.stopDebug()')
            await setSource(code)
            const before = debugCalls.length
            await evaluate(`__nv.debug.startDebug(window.__freopenTestId, ${JSON.stringify(sourcePath)})`)
            assert(
                debugCalls.length === before + 1 && debugCalls[before].source === code,
                `${name}: debug did not receive the current source snapshot`
            )
            requireIO(
                { state: debugCalls[before].fileIOBeforeDispatch, persisted: debugCalls[before].fileIOBeforeDispatch },
                enabled,
                'freopen',
                stem
            )
            await until(
                () => evaluate('Boolean(["paused", "exited", "error"].includes(__nv.store.get().debug.state.status))'),
                `${name}: debug did not reach a usable state`,
                45000
            )
            const io = await readIO()
            requireIO(io, enabled, 'freopen', stem)
            const first = await evaluate('__nv.store.get().debug.state')
            assert(first.status !== 'error', `${name}: debug failed: ${JSON.stringify(first)}`)
            if (first.status === 'paused') await evaluate("iter.debug.command('continue')")
            const state = await until(
                () =>
                    evaluate(
                        '(() => { const state = __nv.store.get().debug.state; return ["exited", "error"].includes(state.status) ? state : null; })()'
                    ),
                `${name}: debug did not exit`,
                45000
            )
            assert(
                state.status === 'exited' && state.exitCode === 0 && state.stdout.includes('42'),
                `${name}: debug output/exit mismatch: ${JSON.stringify(state)}`
            )
            assert(
                fs.readFileSync(sourcePath, 'utf8') === original,
                `${name}: debug unexpectedly saved with auto-save off`
            )
            evidence.debug.push({
                name,
                fileIO: io.persisted,
                exitCode: state.exitCode,
                stdout: state.stdout,
                persistedBeforeDispatch: true,
                currentBuffer: true
            })
            log(`${name}: debug exited normally with output 42`)
            await evaluate('__nv.debug.stopDebug()')
        }
        try {
            await until(() => evaluate('Boolean(window.__nv?.store.get().ready)'), 'Renderer did not become ready')
            const paths = Object.fromEntries(
                ['userData', 'sessionData', 'temp', 'logs', 'crashDumps'].map((name) => [name, app.getPath(name)])
            )
            paths.store = process.env.ITER_STORE
            paths.osTemp = require('node:os').tmpdir()
            for (const [name, value] of Object.entries(paths))
                assert(insideSandbox(value), `${name} escaped the isolated workspace`)
            evidence.paths = paths
            await evaluate(`(async () => {
        const current = await iter.settings.get();
        const settings = await iter.settings.set({ autoSave: false, editor: { ...current.editor, formatOnSave: false } });
        __nv.store.set({ settings });
        window.__freopenJudgeEvents = [];
        iter.judge.onEvent(event => window.__freopenJudgeEvents.push(event));
        await __nv.files.openFile(${JSON.stringify(sourcePath)});
        await __nv.tests.addTest('12 30\\n', '42\\n');
        window.__freopenTestId = __nv.store.get().files.find(file => file.path === ${JSON.stringify(sourcePath)}).tests[0].id;
      })()`)
            await runCase('active-freopen', program('active'), { enabled: true, stem: 'auto' })
            await runCase('line-comment-freopen', program('line'), { enabled: false })
            await runCase('deleted-freopen', program(), { enabled: false })
            await runCase('restored-renamed-freopen', program('active', 'restored'), {
                enabled: true,
                stem: 'restored'
            })
            await runCase('block-comment-freopen', program('block', 'restored'), { enabled: false })
            await runCase('disabled-preprocessor-freopen', program('disabled', 'restored'), { enabled: false })

            // An explicit manual setting remains valid for streams which do not call freopen.
            await toggleIO()
            requireIO(await readIO(), true, 'manual', 'restored')
            await runCase('manual-fstream-preserved', fstreamProgram('restored.in', 'restored.out'), {
                enabled: true,
                origin: 'manual',
                stem: 'restored'
            })
            await setSource(program())
            await detectIO()
            requireIO(await readIO(), false, 'freopen')
            await runCase('explicit-detection-disables', program(), { enabled: false })
            evidence.checks.push('manual UI configuration persists; explicit detection disables absent calls')

            // v0.1.9 had no provenance marker. Verify its stale enabled flag is repaired.
            await evaluate(
                `__nv.tests.saveProblem(${JSON.stringify(sourcePath)}, { fileIO: { enabled: true, input: 'legacy.in', output: 'legacy.out' } })`
            )
            const legacy = await readIO()
            assert(
                legacy.persisted.enabled && !legacy.persisted.origin,
                'Legacy fixture unexpectedly has a provenance marker'
            )
            await runCase('legacy-enabled-without-calls', program(), { enabled: false })

            await debugCase('debug-active-freopen', program('active', 'debug'), true, 'debug')
            await debugCase('debug-commented-freopen', program('line', 'debug'), false)

            // The expected-answer control changes one test's comparison policy only.
            await evaluate(`(() => {
        __nv.store.set({ rightView: 'tests', islandOpen: false });
        __nv.tests.editTest(window.__freopenTestId, { answer: '999\\n' }, ${JSON.stringify(sourcePath)});
      })()`)
            await runCase('comparison-on-wrong-answer', program(), { enabled: false, verdict: 'WA' })
            const toggleComparison = async (enabled) => {
                // A done event precedes the engine's final lease cleanup; join it first.
                await evaluate(`__nv.judge.stopRun(${JSON.stringify(sourcePath)})`)
                await until(
                    () => evaluate('Boolean(document.querySelector(".nv-compare-output input:not(:disabled)"))'),
                    'Per-test comparison checkbox did not become usable'
                )
                await evaluate(`(() => {
          const input = document.querySelector('.nv-compare-output input');
          if (input.checked === ${JSON.stringify(enabled)}) throw Error('Comparison fixture started in the wrong state');
          input.click();
        })()`)
                await until(
                    () =>
                        evaluate(`(async () => {
          const config = await iter.problem.load(${JSON.stringify(sourcePath)});
          const tests = await iter.problem.readTests(${JSON.stringify(sourcePath)});
          return config.tests[0].compareOutput === ${JSON.stringify(enabled)} && tests[0].compareOutput === ${JSON.stringify(enabled)} && tests[0].answer === '999\\n';
        })()`),
                    'Comparison toggle did not persist or changed the answer'
                )
                await until(
                    () =>
                        evaluate(
                            `document.querySelector('.nv-compare-output input')?.checked === ${JSON.stringify(enabled)}`
                        ),
                    'Comparison UI did not reflect the persisted setting'
                )
            }
            await toggleComparison(false)
            await runCase('comparison-off-preserves-output', program(), { enabled: false, verdict: 'NA' })
            await runCase('comparison-off-preserves-runtime-error', program().replace('return 0;', 'return 23;'), {
                enabled: false,
                verdict: 'RE'
            })
            await toggleComparison(true)
            await runCase('comparison-restored-wrong-answer', program(), { enabled: false, verdict: 'WA' })
            await evaluate(
                `__nv.tests.editTest(window.__freopenTestId, { answer: '42\\n' }, ${JSON.stringify(sourcePath)})`
            )
            evidence.checks.push(
                'real per-test UI comparison toggle persists, retains answer/output and preserves runtime errors'
            )

            // The run boundary must use exactly the source saved by auto-save.
            await evaluate(
                `(async () => { const settings = await iter.settings.set({ autoSave: true }); __nv.store.set({ settings, rightView: 'tests' }); })()`
            )
            await runCase('autosave-active-freopen', program('active', 'saved'), { enabled: true, stem: 'saved' }, true)
            await runCase('autosave-deleted-freopen', program(), { enabled: false }, true)
            evidence.checks.push('auto-save and judge use the same current source snapshot')
            await finish()
        } catch (error) {
            await finish(error)
        }
    })
})
log(`Starting built application: ${appRoot}`)
require(path.join(appRoot, 'out', 'main', 'index.js'))
