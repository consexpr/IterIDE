import type * as Monaco from 'monaco-editor'
import { editorRef } from '../editor/instance'
import { formattingEdits } from '../lang/format'
import { activeFile, store, toast } from '../state/app'

async function formatModel(path: string, model: Monaco.editor.ITextModel): Promise<void> {
    const version = model.getVersionId()
    const edits = editorRef.lang
        ? await editorRef.lang.format(model)
        : await formattingEdits(model, path, window.iter, undefined)
    if (!edits.length || model.isDisposed() || model.getVersionId() !== version) return
    const tracking = store.get().breakpoints?.[path]?.length ? await import('./debug') : null
    if (model.isDisposed() || model.getVersionId() !== version) return
    const anchors = tracking?.beginBreakpointFormatting(path, model) ?? null
    const editor = editorRef.editor
    try {
        model.pushStackElement()
        if (editor?.getModel() === model) {
            const selections = editor.getSelections()
            // Startup/close keeps user input locked; controlled save edits must still apply.
            if (editor.executeEdits('iter.format', edits, selections ?? undefined) === false)
                model.pushEditOperations([], edits, () => null)
        } else model.pushEditOperations([], edits, () => null)
        model.pushStackElement()
    } finally {
        tracking?.finishBreakpointFormatting(anchors)
    }
}

export async function formatActive(): Promise<void> {
    const file = activeFile(store.get())
    if (!file) return
    try {
        await formatModel(file.path, file.model)
    } catch (error) {
        toast(`格式化失败：${(error as Error).message}`, 'error')
    }
}

export async function formatOnSaveHook(path: string, model: Monaco.editor.ITextModel): Promise<void> {
    if (!store.get().settings.editor.formatOnSave) return
    try {
        await formatModel(path, model)
    } catch (error) {
        toast(`格式化失败，保存当前内容：${(error as Error).message}`, 'error')
    }
}
