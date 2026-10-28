// Single place that loads Monaco: only the editor features + our own C++ grammar (no bundled
// TS/CSS/JSON language services), which keeps startup and memory small.
import 'monaco-editor/features/register.all'
// register.all only brings the viewport (range) provider; clangd serves whole-document tokens.
import 'monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens'
import * as monaco from 'monaco-editor/editor/editor.api'
// editor.worker (not editor.worker.start, which only exports a factory) installs the worker's message
// loop; without it suggest waits forever on the locality RPC and the widget stays at 'Loading…'.
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import type { EditorSettings } from '../../shared/settings'
import { minimapScale } from '../../shared/settings'
import { indentationSettings } from '../../shared/indentation'
import { registerCppTokens } from './cppTokens'

self.MonacoEnvironment = { getWorker: () => new EditorWorker() }

monaco.languages.register({ id: 'cpp', extensions: ['.cpp', '.cc', '.cxx', '.h', '.hpp'], aliases: ['C++'] })
registerCppTokens(monaco)

export { monaco }
export type MonacoNS = typeof monaco

export function editorOptions(s: EditorSettings): monaco.editor.IStandaloneEditorConstructionOptions {
    const indentation = indentationSettings(s)
    return {
        fontFamily: s.fontFamily,
        fontSize: s.fontSize,
        lineHeight: Math.round(s.fontSize * s.lineHeight),
        fontLigatures: s.ligatures,
        letterSpacing: s.letterSpacing ?? 0,
        fontWeight: String(s.fontWeight ?? 400),
        ...indentation,
        detectIndentation: false,
        // Keep indentation on blank lines when editing the next line or navigating back.
        trimAutoWhitespace: false,
        wordWrap: s.wordWrap ? 'on' : 'off',
        minimap: {
            enabled: s.minimap,
            renderCharacters: true,
            size: 'proportional',
            scale: minimapScale(s.minimapScale),
            showSlider: 'mouseover'
        },
        automaticLayout: true,
        glyphMargin: true,
        lineNumbersMinChars: 3,
        lineDecorationsWidth: 6,
        folding: true,
        showFoldingControls: 'mouseover',
        renderLineHighlight: 'all',
        cursorBlinking: 'smooth',
        cursorSmoothCaretAnimation: 'on',
        smoothScrolling: true,
        scrollBeyondLastLine: true,
        padding: { top: 14, bottom: 14 },
        bracketPairColorization: { enabled: true, independentColorPoolPerBracketType: false },
        guides: { indentation: true, bracketPairs: false, highlightActiveIndentation: true },
        stickyScroll: { enabled: true, maxLineCount: 3 },
        renderWhitespace: 'selection',
        // completion feel: Tab accepts; Enter too only when enabled (else it always inserts a newline)
        quickSuggestions:
            s.completion?.showCompletionWhileInput === false ? false : { other: true, comments: false, strings: false },
        quickSuggestionsDelay: 0,
        suggestOnTriggerCharacters: true,
        acceptSuggestionOnEnter: s.completion?.acceptOnEnter ? 'on' : 'off',
        tabCompletion: 'on',
        wordBasedSuggestions: 'off',
        suggestSelection: 'first',
        snippetSuggestions: 'inline',
        suggest: { showWords: false, preview: true, showStatusBar: false, insertMode: 'replace', localityBonus: true },
        parameterHints: { enabled: true, cycle: true },
        autoClosingBrackets: 'languageDefined',
        autoClosingQuotes: 'languageDefined',
        autoSurround: 'languageDefined',
        autoIndent: 'full',
        'semanticHighlighting.enabled': true,
        formatOnPaste: false,
        matchBrackets: 'always',
        occurrencesHighlight: 'singleFile',
        selectionHighlight: false,
        // AI ghost text: Tab accepts it; it never appears while the suggest widget is open
        inlineSuggest: { enabled: true, mode: 'subwordSmart', showToolbar: 'onHover', suppressSuggestions: false },
        fixedOverflowWidgets: true,
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
        overviewRulerBorder: false,
        hideCursorInOverviewRuler: true,
        contextmenu: true,
        mouseWheelZoom: true
    }
}
