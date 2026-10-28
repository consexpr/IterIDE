// Holds the single Monaco editor instance and the C++ language service so actions can reach them.
import type { CppLanguageService } from '../lang'
import type { monaco } from './monaco'

export const editorRef: {
    editor: monaco.editor.IStandaloneCodeEditor | null
    lang: CppLanguageService | null
} = { editor: null, lang: null }
