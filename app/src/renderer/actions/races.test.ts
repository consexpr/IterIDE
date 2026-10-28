import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const f = vi.hoisted(() => {
    const config = () => ({
        version: 1,
        title: 'A',
        timeLimit: 1000,
        memoryLimit: 512,
        mode: 'standard',
        checker: { kind: 'builtin', builtin: 'tokens' },
        fileIO: { enabled: false, input: 'a.in', output: 'a.out' },
        tests: [{ id: '1', name: '1', enabled: true }]
    })
    const model = () => ({
        getAlternativeVersionId: () => 1,
        getValue: () => 'int main(){}',
        getValueLength() {
            return this.getValue().length
        },
        isDisposed: () => false,
        dispose: vi.fn(),
        setEOL: vi.fn(),
        onDidChangeContent: vi.fn(),
        getVersionId: () => 1,
        getOptions: () => ({ tabSize: 4, indentSize: 4, insertSpaces: true }),
        updateOptions: vi.fn()
    })
    const file = (path: string) => ({
        path,
        name: path,
        missing: false,
        savedText: 'int main(){}',
        model: model(),
        dirty: false,
        savedVersion: 1,
        problem: config(),
        tests: [{ id: '1', name: '1', enabled: true, input: 'old', answer: '', truncated: false }],
        results: {},
        runId: null,
        compile: null,
        lastVerdict: null
    })
    let state: any
    const models = new Map<string, any>()
    const api: any = {
        app: { platform: 'linux', confirmUnsaved: vi.fn(async () => 'discard') },
        session: { save: vi.fn(async () => {}) },
        fs: { readText: vi.fn(async () => 'int main(){}'), writeText: vi.fn(async () => {}) },
        problem: {
            load: vi.fn(async () => config()),
            readTests: vi.fn(async () => []),
            save: vi.fn(async () => {}),
            patch: vi.fn(async (_path, patch) => ({ ...config(), ...patch })),
            updateTest: vi.fn(async () => config()),
            saved: vi.fn(async () => {}),
            writeTest: vi.fn(async () => '1'),
            deleteTests: vi.fn(async () => {})
        },
        settings: { set: vi.fn(async () => state.settings) },
        importer: { detectForSource: vi.fn(async () => null) },
        lsp: { refreshCompileFlags: vi.fn(async () => {}) },
        judge: {
            run: vi.fn(async (req) => req.operationId ?? 'old-run'),
            stop: vi.fn(async () => {}),
            onEvent: vi.fn()
        },
        debug: {
            onEvent: vi.fn(),
            start: vi.fn(async () => {}),
            command: vi.fn(async () => {}),
            locals: vi.fn(async () => []),
            stack: vi.fn(async () => [])
        }
    }
    const reset = () => {
        state = {
            files: [file('/a.cpp')],
            activePath: '/a.cpp',
            settings: { editor: { formatOnSave: false }, autoSave: true, recentFiles: [] },
            rightView: 'tests',
            toasts: [],
            expanded: {},
            debug: { state: { status: 'idle' }, tab: 'variables' },
            breakpoints: {}
        }
        models.clear()
    }
    reset()
    return {
        config,
        model,
        file,
        get state() {
            return state
        },
        set state(v) {
            state = v
        },
        models,
        api,
        reset,
        toast: vi.fn(),
        editorRef: { editor: null as any, lang: null }
    }
})

vi.mock('../state/app', () => ({
    store: {
        get: () => f.state,
        set: (patch: any) => {
            f.state = { ...f.state, ...(typeof patch === 'function' ? patch(f.state) : patch) }
        }
    },
    activeFile: (s = f.state) => s.files.find((x: any) => x.path === s.activePath) ?? null,
    updateFile: (path: string, patch: any) => {
        f.state = {
            ...f.state,
            files: f.state.files.map((x: any) =>
                x.path === path ? { ...x, ...(typeof patch === 'function' ? patch(x) : patch) } : x
            )
        }
    },
    toast: f.toast,
    isDebugging: () => false,
    emptyDebug: () => ({
        state: { status: 'idle' },
        path: null,
        testId: null,
        stdout: '',
        stderr: '',
        locals: [],
        stack: [],
        frame: 0,
        tab: 'variables',
        bpInfo: []
    })
}))
vi.mock('../editor/instance', () => ({ editorRef: f.editorRef }))
vi.mock('../editor/monaco', () => ({
    monaco: {
        Uri: { file: (path: string) => ({ path }) },
        editor: {
            EndOfLineSequence: { LF: 0 },
            getModel: (uri: any) => f.models.get(uri.path),
            createModel: (_text: string, _lang: string, uri: any) => {
                const m = f.model()
                f.models.set(uri.path, m)
                return m
            }
        }
    }
}))

beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.useFakeTimers()
    f.reset()
    f.api.app.platform = 'linux'
    delete f.api.app.onCloseRequest
    delete f.api.app.resolveClose
    f.editorRef.editor = null
    vi.stubGlobal('window', { iter: f.api })
    vi.stubGlobal(
        'confirm',
        vi.fn(() => true)
    )
})
afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

describe('file and problem operation races', () => {
    it('refreshes clangd header paths after loading imported grader configuration', async () => {
        const { reloadProblem } = await import('./files')
        f.api.problem.load.mockResolvedValueOnce({
            ...f.config(),
            mode: 'grader',
            grader: { sources: ['/cache/grader.cpp'], includeDirs: ['/cache/include'] }
        })
        await reloadProblem('/a.cpp')
        expect(f.state.files[0].problem.grader.includeDirs).toEqual(['/cache/include'])
        expect(f.api.lsp.refreshCompileFlags).toHaveBeenCalledWith('/a.cpp')
    })
    it('keeps a pending complete edit writable when refreshed metadata marks unloaded previews truncated', async () => {
        const { editTest } = await import('./tests')
        const { reloadProblem } = await import('./files')
        editTest('1', { input: '完整输入', answer: '答案' })
        f.api.problem.readTests.mockResolvedValueOnce([
            {
                id: '1',
                name: 'one',
                enabled: true,
                input: '',
                answer: '',
                inputSize: 100,
                answerSize: 100,
                truncated: true,
                previewLoaded: false
            }
        ])
        await reloadProblem('/a.cpp')
        expect(f.state.files[0].tests[0]).toMatchObject({
            input: '完整输入',
            answer: '答案',
            inputSize: 12,
            answerSize: 6,
            truncated: false,
            previewLoaded: true
        })
        editTest('1', { input: 'still editable' })
        await vi.advanceTimersByTimeAsync(400)
        expect(f.api.problem.writeTest).toHaveBeenLastCalledWith(
            '/a.cpp',
            expect.objectContaining({ input: 'still editable', answer: '答案' })
        )
    })
    it('saves settings against the captured path using a patch', async () => {
        const { saveProblem } = await import('./tests')
        f.state.files.push(f.file('/b.cpp'))
        f.state.activePath = '/b.cpp'
        await (saveProblem as any)('/a.cpp', { timeLimit: 2000 })
        expect(f.api.problem.patch).toHaveBeenCalledWith('/a.cpp', { timeLimit: 2000 })
        expect(f.state.files[1].problem.timeLimit).toBe(1000)
    })

    it('does not resurrect a test deleted before its debounce fires', async () => {
        const { editTest, deleteTests } = await import('./tests')
        editTest('1', { input: 'new' })
        await deleteTests(['1'])
        await vi.advanceTimersByTimeAsync(500)
        expect(f.api.problem.writeTest).not.toHaveBeenCalled()
    })

    it('removes committed deletions locally when refreshing the problem fails', async () => {
        const { editTest, deleteTests } = await import('./tests')
        f.state.files[0].tests.push({ id: '2', input: 'keep', answer: '', truncated: false })
        f.state.files[0].problem.tests.push({ id: '2', name: 'keep', enabled: true })
        f.state.files[0].results = { '1': { verdict: 'WA' }, '2': { verdict: 'AC' } }
        f.api.problem.load.mockRejectedValueOnce(new Error('read failed'))
        await deleteTests(['1'])
        expect(f.api.problem.deleteTests).toHaveBeenCalledWith('/a.cpp', ['1'])
        expect(f.state.files[0].tests.map((test: { id: string }) => test.id)).toEqual(['2'])
        expect(f.state.files[0].problem.tests.map((test: { id: string }) => test.id)).toEqual(['2'])
        expect(f.state.files[0].results).toEqual({ '2': { verdict: 'AC' } })
        editTest('1', { input: 'must not recreate' })
        await vi.advanceTimersByTimeAsync(500)
        expect(f.api.problem.writeTest).not.toHaveBeenCalled()
    })

    it('flushes edited test data before a run starts', async () => {
        const { editTest } = await import('./tests')
        const { runTests } = await import('./judge')
        let persisted = 'old'
        f.api.problem.writeTest.mockImplementationOnce(async (_p: string, t: any) => {
            persisted = t.input
            return '1'
        })
        f.api.judge.run.mockImplementationOnce(async (req: any) => {
            expect(persisted).toBe('new')
            return req.operationId ?? 'run'
        })
        editTest('1', { input: 'new' })
        await runTests()
        expect(f.api.problem.writeTest).toHaveBeenCalled()
    })

    it('disables a legacy freopen configuration before judging a commented-out program', async () => {
        const { runTests } = await import('./judge')
        f.state.files[0].problem.fileIO.enabled = true
        f.state.files[0].model.getValue = () => '// freopen("a.in", "r", stdin);\nint main(){}'
        f.api.judge.run.mockImplementationOnce(async (req: any) => {
            expect(f.state.files[0].problem.fileIO).toMatchObject({
                enabled: false,
                input: 'a.in',
                output: 'a.out',
                origin: 'freopen'
            })
            return req.operationId
        })
        await runTests()
        expect(f.api.problem.patch).toHaveBeenCalledWith('/a.cpp', {
            fileIO: { enabled: false, input: 'a.in', output: 'a.out', origin: 'freopen' }
        })
        expect(f.api.judge.run).toHaveBeenCalledOnce()
    })

    it('reenables file IO before judging when freopen calls are restored', async () => {
        const { runTests } = await import('./judge')
        f.state.files[0].model.getValue = () => 'freopen("new.in", "r", stdin); freopen("new.out", "w", stdout);'
        f.api.judge.run.mockImplementationOnce(async (req: any) => {
            expect(f.state.files[0].problem.fileIO).toMatchObject({
                enabled: true,
                input: 'new.in',
                output: 'new.out',
                origin: 'freopen'
            })
            return req.operationId
        })
        await runTests()
        expect(f.api.judge.run).toHaveBeenCalledOnce()
    })

    it('retains a newly opened file while another dirty file finishes closing', async () => {
        const { closeFile } = await import('./files')
        f.state.files[0].dirty = true
        let resolve!: () => void
        f.api.fs.writeText.mockImplementationOnce(
            () =>
                new Promise<void>((r) => {
                    resolve = r
                })
        )
        const closing = closeFile('/a.cpp')
        await vi.waitFor(() => expect(f.api.fs.writeText).toHaveBeenCalled())
        f.state = { ...f.state, files: [...f.state.files, f.file('/b.cpp')], activePath: '/b.cpp' }
        resolve()
        await closing
        expect(f.state.files.map((x: any) => x.path)).toEqual(['/b.cpp'])
        expect(f.state.activePath).toBe('/b.cpp')
    })

    it('coalesces concurrent opens of the same model', async () => {
        const { openFile } = await import('./files')
        f.state.files = []
        f.state.activePath = null
        await Promise.all([openFile('/a.cpp'), openFile('/a.cpp')])
        expect(f.state.files).toHaveLength(1)
        expect(f.api.fs.readText).toHaveBeenCalledTimes(1)
    })

    it('opens source without detecting or importing neighboring test data', async () => {
        const { openFile } = await import('./files')
        f.state.files = []
        f.state.activePath = null
        await openFile('/exam/solution.cpp')
        await Promise.resolve()
        expect(f.api.problem.load).toHaveBeenCalledWith('/exam/solution.cpp')
        expect(f.api.importer.detectForSource).not.toHaveBeenCalled()
    })

    it('returns home while preserving unsaved models and editor view state', async () => {
        const { showHome, activate } = await import('./files')
        const original = f.state.files[0]
        original.dirty = true
        const viewState = { scrollTop: 123 }
        f.editorRef.editor = {
            saveViewState: () => viewState,
            setModel: vi.fn(),
            restoreViewState: vi.fn(),
            focus: vi.fn()
        }
        showHome()
        expect(f.state.activePath).toBeNull()
        expect(f.state.files[0]).toMatchObject({ dirty: true, model: original.model, viewState })
        expect(original.model.dispose).not.toHaveBeenCalled()
        activate('/a.cpp')
        expect(f.state.activePath).toBe('/a.cpp')
        expect(f.editorRef.editor.restoreViewState).toHaveBeenCalledWith(viewState)
    })

    it('waits for an in-flight test write before deleting, and ignores edits during deletion', async () => {
        const { editTest, deleteTests } = await import('./tests')
        let resolve!: () => void
        f.api.problem.writeTest.mockImplementationOnce(
            () =>
                new Promise<void>((r) => {
                    resolve = r
                })
        )
        editTest('1', { input: 'new' })
        await vi.advanceTimersByTimeAsync(400)
        const deleting = deleteTests(['1'])
        await Promise.resolve()
        await Promise.resolve()
        editTest('1', { input: 'must not recreate' })
        expect(f.api.problem.deleteTests).not.toHaveBeenCalled()
        resolve()
        await deleting
        await vi.advanceTimersByTimeAsync(500)
        expect(f.api.problem.writeTest).toHaveBeenCalledTimes(1)
        expect(f.api.problem.deleteTests).toHaveBeenCalledTimes(1)
    })

    it('keeps the label and model when saving during close fails', async () => {
        const { closeFile } = await import('./files')
        const file = f.state.files[0]
        file.dirty = true
        f.api.fs.writeText.mockRejectedValueOnce(new Error('disk full'))
        await closeFile(file.path)
        expect(f.state.files).toHaveLength(1)
        expect(file.model.dispose).not.toHaveBeenCalled()
        expect(f.toast).toHaveBeenCalledWith(expect.stringContaining('disk full'), 'error', 6000)
    })

    it('owns events emitted before the run response and ignores completion of an older run', async () => {
        const { listenJudge, runTests } = await import('./judge')
        listenJudge()
        const event = f.api.judge.onEvent.mock.calls[0][0]
        let firstId = ''
        f.api.judge.run.mockImplementationOnce(async (req: any) => {
            firstId = req.operationId
            event({
                type: 'test-done',
                runId: firstId,
                result: { testId: '1', verdict: 'AC', timeMs: 2, output: 'first', stderr: '', exitCode: 0 }
            })
            return firstId
        })
        await runTests()
        expect(f.state.files[0].results['1'].output).toBe('first')
        await runTests()
        const secondId = f.state.files[0].runId
        expect(secondId).not.toBe(firstId)
        event({ type: 'done', runId: firstId, summary: { verdict: 'WA' } })
        expect(f.state.files[0].runId).toBe(secondId)
        expect(f.state.files[0].lastVerdict).toBe(null)
    })

    it('serializes a replacement run behind the first start acknowledgement', async () => {
        const { runTests } = await import('./judge')
        let acknowledge!: () => void
        f.api.judge.run.mockImplementationOnce(
            (req: any) =>
                new Promise<string>((r) => {
                    acknowledge = () => r(req.operationId)
                })
        )
        const first = runTests()
        await vi.waitFor(() => expect(f.api.judge.run).toHaveBeenCalledTimes(1))
        const second = runTests()
        await Promise.resolve()
        await Promise.resolve()
        expect(f.api.judge.run).toHaveBeenCalledTimes(1)
        acknowledge()
        await Promise.all([first, second])
        expect(f.api.judge.run).toHaveBeenCalledTimes(2)
        expect(f.api.judge.stop).toHaveBeenCalledTimes(1)
        expect(f.api.judge.stop.mock.invocationCallOrder[0]).toBeLessThan(f.api.judge.run.mock.invocationCallOrder[1])
    })

    it('quits without asking: auto-save writes dirty files, otherwise the session keeps them', async () => {
        const { prepareAppClose } = await import('./lifecycle')
        f.state.files[0].dirty = true
        f.state.settings.autoSave = false
        expect(await prepareAppClose()).toBe('ready')
        expect(f.api.fs.writeText).not.toHaveBeenCalled()
        expect(f.api.session.save).toHaveBeenCalledWith(
            expect.objectContaining({
                version: 1,
                tabs: [expect.objectContaining({ path: '/a.cpp', text: 'int main(){}' })]
            })
        )
        f.api.session.save.mockClear()
        f.state.settings.autoSave = true
        expect(await prepareAppClose()).toBe('ready')
        expect(f.api.fs.writeText).toHaveBeenCalledTimes(1)
        expect(f.state.files[0].dirty).toBe(false)
    })

    it('preserves pending settings and test contents across a disk refresh', async () => {
        const { editTest, editProblemSettings } = await import('./tests')
        const { reloadProblem } = await import('./files')
        f.api.problem.readTests.mockResolvedValueOnce([{ ...f.state.files[0].tests[0], input: 'old disk content' }])
        const loading = reloadProblem('/a.cpp')
        editTest('1', { input: 'unsaved latest content' })
        editProblemSettings('/a.cpp', { timeLimit: 2000 })
        await loading
        expect(f.state.files[0].problem.timeLimit).toBe(2000)
        expect(f.state.files[0].tests[0].input).toBe('unsaved latest content')
    })

    it('does not apply a settings response over newer test metadata', async () => {
        const { saveProblem } = await import('./tests')
        let resolve!: (value: any) => void
        f.api.problem.patch.mockImplementationOnce(
            () =>
                new Promise((r) => {
                    resolve = r
                })
        )
        const saved = saveProblem('/a.cpp', { timeLimit: 2000 })
        await vi.waitFor(() => expect(f.api.problem.patch).toHaveBeenCalled())
        f.state.files[0].problem.tests.push({ id: '2', name: 'new case', enabled: true })
        resolve({ ...f.config(), timeLimit: 2000 })
        await saved
        expect(f.state.files[0].problem.tests.map((test: any) => test.id)).toEqual(['1', '2'])
    })

    it('retains both checker configurations through rapid toggles before the debounced save', async () => {
        const { editProblemSettings, flushProblemWrites } = await import('./tests')
        const { checkerSettingsPatch } = await import('../../shared/checkerSelection')
        f.state.files[0].problem.checker = {
            kind: 'custom',
            path: 'checker.cpp',
            args: '{answer} {output} {input}',
            builtin: 'lines',
            value: 'float6'
        }
        for (const kind of ['builtin', 'custom', 'builtin', 'custom'] as const) {
            editProblemSettings('/a.cpp', checkerSettingsPatch(f.state.files[0].problem, { kind }))
        }
        await flushProblemWrites('/a.cpp')
        expect(f.state.files[0].problem.checker).toMatchObject({
            kind: 'custom',
            path: 'checker.cpp',
            args: '{answer} {output} {input}',
            builtin: 'lines',
            value: 'float6'
        })
        expect(f.api.problem.patch).toHaveBeenCalledTimes(1)
    })

    it('does not optimistically switch the displayed mode during a run', async () => {
        const { editProblemSettings } = await import('./tests')
        f.state.files[0].runId = 'active'
        editProblemSettings('/a.cpp', { mode: 'interactive' })
        expect(f.state.files[0].problem.mode).toBe('standard')
        expect(f.api.problem.patch).not.toHaveBeenCalled()
    })

    it('normalizes Windows separator, case and dot variants before opening', async () => {
        const { openFile } = await import('./files')
        f.api.app.platform = 'win32'
        f.state.files = []
        await Promise.all([openFile('C:\\Work\\a.cpp'), openFile('c:/work/./a.cpp')])
        expect(f.state.files).toHaveLength(1)
        expect(f.api.fs.readText).toHaveBeenCalledTimes(1)
    })

    it('closes two dirty files concurrently without restoring either disposed model', async () => {
        const { closeFile } = await import('./files')
        const a = f.state.files[0],
            b = f.file('/b.cpp')
        a.dirty = b.dirty = true
        f.state.files = [a, b]
        await Promise.all([closeFile(a.path), closeFile(b.path)])
        expect(f.state.files).toEqual([])
        expect(a.model.dispose).toHaveBeenCalledTimes(1)
        expect(b.model.dispose).toHaveBeenCalledTimes(1)
    })

    it('unfreezes the UI when main rejects a ready acknowledgement', async () => {
        let receive!: (event: { requestId: string }) => void
        f.api.app.onCloseRequest = vi.fn((callback) => {
            receive = callback
            return vi.fn()
        })
        f.api.app.resolveClose = vi.fn(async () => {
            throw new Error('close request expired')
        })
        f.editorRef.editor = {
            updateOptions: vi.fn(),
            getModel: vi.fn(() => null),
            getAction: vi.fn((id: string) => (id === 'editor.action.hideHover' ? { run: vi.fn(async () => {}) } : null))
        }
        const { listenAppClose } = await import('./lifecycle')
        listenAppClose()
        receive({ requestId: 'close-1' })
        expect(f.state.closing).toBe(true)
        await vi.waitFor(() => expect(f.state.closing).toBe(false))
        expect(f.api.app.resolveClose).toHaveBeenCalledWith('close-1', 'ready')
        expect(f.editorRef.editor.updateOptions).toHaveBeenLastCalledWith({ readOnly: false })
    })

    it('flushes test changes before debugging and displays bounded delta output plus rewind resets', async () => {
        const { editTest } = await import('./tests')
        const { startDebug, listenDebug } = await import('./debug')
        editTest('1', { input: 'new debug input' })
        await startDebug()
        expect(f.api.problem.writeTest.mock.invocationCallOrder[0]).toBeLessThan(
            f.api.debug.start.mock.invocationCallOrder[0]
        )
        listenDebug()
        const event = f.api.debug.onEvent.mock.calls[0][0]
        event({
            type: 'output-delta',
            stdout: 'x'.repeat(210_000),
            stderr: 'e',
            resetStdout: true,
            resetStderr: true,
            stdoutOffset: 210_000,
            stderrOffset: 1
        })
        expect(f.state.debug.stdout).toHaveLength(200_000)
        event({ type: 'output-delta', stdout: 'r', resetStdout: true, stdoutOffset: 1, stderrOffset: 1 })
        expect(f.state.debug.stdout).toBe('r')
        expect(f.state.debug.stderr).toBe('e')
        event({ type: 'output', stdout: 'old', stderr: '', stdoutOffset: 3, stderrOffset: 0 })
        event({ type: 'output-delta', stdout: '!', stdoutOffset: 4, stderrOffset: 0 })
        expect(f.state.debug.stdout).toBe('old!')
    })

    it('joins cleanup after a done event before retrying pending test writes on exit', async () => {
        const { runTests, listenJudge } = await import('./judge')
        const { editTest } = await import('./tests')
        const { prepareAppClose } = await import('./lifecycle')
        listenJudge()
        const event = f.api.judge.onEvent.mock.calls[0][0]
        let leased = false
        f.api.judge.run.mockImplementationOnce(async (request: any) => {
            leased = true
            event({ type: 'done', runId: request.operationId, summary: { verdict: 'AC' } })
            return request.operationId
        })
        f.api.judge.stop.mockImplementationOnce(async () => {
            leased = false
        })
        f.api.problem.writeTest.mockImplementationOnce(async () => {
            if (leased) throw new Error('problem is running')
            return '1'
        })
        await runTests()
        expect(f.state.files[0].runId).toBe(null)
        editTest('1', { input: 'must survive the active run' })
        await vi.advanceTimersByTimeAsync(400)
        expect(f.api.problem.writeTest).toHaveBeenCalledTimes(1)
        f.api.problem.writeTest.mockImplementationOnce(async () => {
            expect(leased).toBe(false)
            return '1'
        })
        expect(await prepareAppClose()).toBe('ready')
        expect(f.api.problem.writeTest).toHaveBeenCalledTimes(2)
        expect(f.api.judge.stop.mock.invocationCallOrder[0]).toBeLessThan(
            f.api.problem.writeTest.mock.invocationCallOrder[1]
        )
    })

    it.each(['judge first', 'debug first'])('does not form a circular wait when starts compete: %s', async (order) => {
        const { runTests } = await import('./judge')
        const { startDebug } = await import('./debug')
        if (order === 'judge first') {
            await Promise.all([runTests(), startDebug()])
            expect(f.api.debug.start).toHaveBeenCalledTimes(1)
            expect(f.api.judge.run).not.toHaveBeenCalled()
        } else {
            await Promise.all([startDebug(), runTests()])
            expect(f.api.judge.run).toHaveBeenCalledTimes(1)
            const stopped = f.api.debug.command.mock.invocationCallOrder.at(-1)!
            expect(stopped).toBeLessThan(f.api.judge.run.mock.invocationCallOrder[0])
            if (f.api.debug.start.mock.calls.length)
                expect(f.api.debug.start.mock.invocationCallOrder[0]).toBeLessThan(stopped)
            expect(f.state.debug.state.status).toBe('idle')
        }
    })

    it('thaws after a close preparation deadline without granting a late ready response', async () => {
        let receive!: (event: { requestId: string }) => void, completeWrite!: () => void
        f.api.app.onCloseRequest = vi.fn((callback) => {
            receive = callback
            return vi.fn()
        })
        f.api.app.resolveClose = vi.fn(async () => {})
        f.api.fs.writeText.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    completeWrite = resolve
                })
        )
        f.state.files[0].dirty = true
        f.editorRef.editor = {
            updateOptions: vi.fn(),
            getAction: vi.fn((id: string) => (id === 'editor.action.hideHover' ? { run: vi.fn(async () => {}) } : null))
        }
        const { listenAppClose, CLOSE_PREPARE_TIMEOUT_MS } = await import('./lifecycle')
        const off = listenAppClose()
        receive({ requestId: 'expired' })
        await vi.waitFor(() => expect(f.api.fs.writeText).toHaveBeenCalledTimes(1))
        await vi.advanceTimersByTimeAsync(CLOSE_PREPARE_TIMEOUT_MS)
        expect(f.state.closing).toBe(false)
        expect(f.editorRef.editor.updateOptions).toHaveBeenLastCalledWith({ readOnly: false })
        expect(f.api.app.resolveClose).toHaveBeenCalledExactlyOnceWith('expired', 'cancel')
        completeWrite()
        await vi.advanceTimersByTimeAsync(0)
        expect(f.state.files[0].dirty).toBe(false)
        expect(f.api.app.resolveClose).not.toHaveBeenCalledWith('expired', 'ready')
        off()
    })

    it('does not let an expired preparation unlock the next close generation', async () => {
        let receive!: (event: { requestId: string }) => void, firstWrite!: () => void, secondWrite!: () => void
        f.api.app.onCloseRequest = vi.fn((callback) => {
            receive = callback
            return vi.fn()
        })
        f.api.app.resolveClose = vi.fn(async () => {})
        f.api.fs.writeText
            .mockImplementationOnce(
                () =>
                    new Promise<void>((resolve) => {
                        firstWrite = resolve
                    })
            )
            .mockImplementationOnce(
                () =>
                    new Promise<void>((resolve) => {
                        secondWrite = resolve
                    })
            )
        f.state.files[0].dirty = true
        const { listenAppClose, CLOSE_PREPARE_TIMEOUT_MS } = await import('./lifecycle')
        const off = listenAppClose()
        receive({ requestId: 'first' })
        await vi.waitFor(() => expect(f.api.fs.writeText).toHaveBeenCalledTimes(1))
        await vi.advanceTimersByTimeAsync(CLOSE_PREPARE_TIMEOUT_MS)
        receive({ requestId: 'next' })
        // The next save is serialized after the uncancellable first write.
        await vi.advanceTimersByTimeAsync(0)
        // A real edit after the expired attempt requires the next generation to save again.
        f.state.files[0].model.getValue = () => 'edit accepted between close attempts'
        f.state.files[0].model.getAlternativeVersionId = () => 2
        firstWrite()
        await vi.waitFor(() => expect(f.api.fs.writeText).toHaveBeenCalledTimes(2))
        expect(f.state.closing).toBe(true)
        expect(f.api.app.resolveClose).not.toHaveBeenCalledWith('first', 'ready')
        secondWrite()
        await vi.waitFor(() => expect(f.api.app.resolveClose).toHaveBeenCalledWith('next', 'ready'))
        expect(f.state.closing).toBe(true)
        off()
    })

    it('blocks edits throughout a replacement import even after its dialog is gone', async () => {
        const { editTest } = await import('./tests')
        const { reloadProblem } = await import('./files')
        const { withProblemMutation, withTestReplacement } = await import('./problemWrites')
        let commit!: () => void
        const apply = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    commit = resolve
                })
        )
        editTest('1', { input: 'accepted before replacement' })
        const replacing = withProblemMutation('/a.cpp', () =>
            withTestReplacement('/a.cpp', apply, () => reloadProblem('/a.cpp'))
        )
        await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1))
        expect(f.api.problem.writeTest).toHaveBeenCalledTimes(1)
        editTest('1', { input: 'must not resurrect the replaced case' })
        await vi.advanceTimersByTimeAsync(500)
        expect(f.api.problem.writeTest).toHaveBeenCalledTimes(1)
        const next = { ...f.state.files[0].tests[0], id: 'imported', input: 'imported data' }
        f.api.problem.load.mockResolvedValueOnce({
            ...f.config(),
            tests: [{ id: 'imported', name: 'new', enabled: true }]
        })
        f.api.problem.readTests.mockResolvedValueOnce([next])
        commit()
        await replacing
        editTest('1', { input: 'stale old card event' })
        await vi.advanceTimersByTimeAsync(500)
        expect(f.api.problem.writeTest).toHaveBeenCalledTimes(1)
        expect(f.state.files[0].tests.map((test: any) => test.id)).toEqual(['imported'])
    })

    it('removes committed old rows even if replacement refresh fails', async () => {
        const { editTest } = await import('./tests')
        const { withTestReplacement } = await import('./problemWrites')
        await expect(
            withTestReplacement(
                '/a.cpp',
                async () => 'committed',
                async () => {
                    throw new Error('refresh failed')
                }
            )
        ).rejects.toThrow('refresh failed')
        expect(f.state.files[0].tests).toEqual([])
        editTest('1', { input: 'stale old card event' })
        await vi.advanceTimersByTimeAsync(500)
        expect(f.api.problem.writeTest).not.toHaveBeenCalled()
    })

    it('uses the same deletion gate for folder replacement', async () => {
        const { editTest } = await import('./tests')
        const { applyProblemFolder } = await import('./folders')
        let commit!: () => void
        f.api.fs.exists = vi.fn(async () => true)
        f.api.importer.applyFolder = vi.fn(
            () =>
                new Promise((resolve) => {
                    commit = () => resolve({ sourcePath: '/a.cpp', added: 1 })
                })
        )
        const replacing = applyProblemFolder({ name: 'exam', dir: '/exam', pairs: [] } as any, '/a.cpp', false, true)
        await vi.waitFor(() => expect(f.api.importer.applyFolder).toHaveBeenCalledTimes(1))
        expect(f.api.importer.applyFolder).toHaveBeenCalledWith(expect.objectContaining({ replaceTests: true }))
        editTest('1', { input: 'must not resurrect after folder replacement' })
        await vi.advanceTimersByTimeAsync(500)
        expect(f.api.problem.writeTest).not.toHaveBeenCalled()
        commit()
        await replacing
        expect(f.state.files[0].tests).toEqual([])
    })
})
