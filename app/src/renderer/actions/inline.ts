import { aiCompletionSettings } from '../../shared/inlineAi'
import { editorRef } from '../editor/instance'
import { activateInlineShortcut } from '../lang/inlineControl'
import { store } from '../state/app'

export function fimShortcut(): void {
    const ai = aiCompletionSettings(store.get().settings.editor.completion.ai)
    if (!ai.enabled || !ai.apiKey) return
    const editor = editorRef.editor
    if (!editor || !editor.hasTextFocus()) return
    activateInlineShortcut()
    editor.trigger('fim-shortcut', 'editor.action.inlineSuggest.trigger', {})
}
