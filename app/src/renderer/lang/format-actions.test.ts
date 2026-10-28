import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { formatActive, formatOnSaveHook } from '../actions/format'

const f = vi.hoisted(() => {
    const model = {
        getVersionId: vi.fn(() => 1),
        getAlternativeVersionId: vi.fn(() => 1),
        getValue: vi.fn(() => 'int  x;'),
        isDisposed: vi.fn(() => false),
        pushStackElement: vi.fn(),
        pushEditOperations: vi.fn()
    }
    const edits = [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 8 }, text: 'int x;\n' }]
    const selections = [
        { selectionStartLineNumber: 1, selectionStartColumn: 4, positionLineNumber: 1, positionColumn: 4 }
    ]
    const editor = { getModel: () => model, getSelections: () => selections, executeEdits: vi.fn() }
    const lang = { format: vi.fn(async () => edits) }
    const state = {
        activePath: '/tmp/a.cpp',
        settings: { editor: { formatOnSave: true } },
        files: [{ path: '/tmp/a.cpp', model, savedText: 'int  x;' }]
    }
    return {
        model,
        edits,
        selections,
        editor,
        lang,
        state,
        ref: { editor: editor as typeof editor | null, lang },
        toast: vi.fn(),
        updateFile: vi.fn(),
        api: { fs: { writeText: vi.fn(async () => {}) }, problem: { saved: vi.fn(async () => {}) } }
    }
})
vi.mock('../editor/instance', () => ({ editorRef: f.ref }))
vi.mock('../editor/monaco', () => ({ monaco: {} }))
vi.mock('../state/app', () => ({
    store: { get: () => f.state },
    activeFile: () => f.state.files[0],
    toast: f.toast,
    updateFile: f.updateFile
}))

beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', { iter: f.api })
    f.ref.editor = f.editor
    f.state.settings.editor.formatOnSave = true
    f.model.getVersionId.mockReturnValue(1)
    f.model.getAlternativeVersionId.mockReturnValue(1)
    f.lang.format.mockResolvedValue(f.edits)
})
afterEach(() => vi.unstubAllGlobals())

describe('format actions and saving', () => {
    it('uses one undo group and preserves active selections', async () => {
        await formatActive()
        expect(f.model.pushStackElement).toHaveBeenCalledTimes(2)
        expect(f.editor.executeEdits).toHaveBeenCalledExactlyOnceWith('iter.format', f.edits, f.selections)
        expect(f.model.pushEditOperations).not.toHaveBeenCalled()
        expect(f.model.pushStackElement.mock.invocationCallOrder[0]).toBeLessThan(
            f.editor.executeEdits.mock.invocationCallOrder[0]
        )
        expect(f.model.pushStackElement.mock.invocationCallOrder[1]).toBeGreaterThan(
            f.editor.executeEdits.mock.invocationCallOrder[0]
        )
    })

    it('formats background models without switching the editor and skips stale results', async () => {
        f.ref.editor = null
        await formatOnSaveHook('/tmp/a.cpp', f.model as any)
        expect(f.model.pushEditOperations).toHaveBeenCalledExactlyOnceWith([], f.edits, expect.any(Function))
        f.model.pushEditOperations.mockClear()
        f.model.getVersionId.mockReturnValueOnce(1).mockReturnValueOnce(2)
        await formatActive()
        expect(f.model.pushEditOperations).not.toHaveBeenCalled()
    })

    it('awaits formatting before saving; failed formatting still saves and reports the error', async () => {
        const { saveFile } = await import('../actions/files')
        f.editor.executeEdits.mockImplementationOnce(() => {
            f.model.getValue.mockReturnValueOnce('int x;\n')
        })
        await saveFile()
        expect(f.api.fs.writeText).toHaveBeenLastCalledWith('/tmp/a.cpp', 'int x;\n', {
            expected: 'int  x;',
            confirmOverwrite: true
        })
        expect(f.editor.executeEdits.mock.invocationCallOrder[0]).toBeLessThan(
            f.api.fs.writeText.mock.invocationCallOrder[0]
        )
        f.lang.format.mockRejectedValueOnce(new Error('tool missing'))
        await saveFile()
        expect(f.toast).toHaveBeenLastCalledWith(expect.stringContaining('tool missing'), 'error')
        expect(f.api.fs.writeText).toHaveBeenLastCalledWith('/tmp/a.cpp', 'int  x;', {
            expected: 'int  x;',
            confirmOverwrite: true
        })
        f.state.settings.editor.formatOnSave = false
        const calls = f.lang.format.mock.calls.length
        await saveFile()
        expect(f.lang.format).toHaveBeenCalledTimes(calls)
    })
})
