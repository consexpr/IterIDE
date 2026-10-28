import { APP_NAME } from '../../shared/brand'
import type * as Monaco from 'monaco-editor'
import type { IterApi } from '../../shared/api'
import { LspClient, type RequestHandle } from './rpc'
import { formattingEdits, formattingToken } from './format'
import {
    indexIdentifiers,
    fallbackCandidates,
    supplementalCandidates,
    pinSyntax,
    rankCandidates,
    semanticCandidates,
    type Candidate,
    type CompletionCategory,
    type Identifier
} from './ranking'
import { completionContext, type CompletionContext } from './context'
import { completionOptions, type CompletionOptions } from './options'
import { modelRank, type ModelMemory } from './model'
import { CompletionUsageStore, type CompletionUsage } from './usage'
import { trackCompletionParentheses } from './completionBrackets'
import { CLIENT_CAPABILITY, ITER_LEGEND, remapSemanticTokens, type SemanticLegend } from './semantic'
import {
    lspPosition,
    markdown,
    monacoRange,
    parentDirectory,
    sourceUri,
    uriKey,
    type LspCompletionItem,
    type LspCompletionList,
    type LspDiagnostic,
    type LspRange,
    type LspTextEdit
} from './protocol'

export type CppLanguageStatus = 'starting' | 'clangd' | 'fallback'
export interface CppLanguageService {
    attach(model: Monaco.editor.ITextModel, sourcePath: string): void
    detach(model: Monaco.editor.ITextModel): void
    rename(model: Monaco.editor.ITextModel, newPath: string): void
    setHoverEnabled(enabled: boolean): void
    status(): CppLanguageStatus
    onStatus(cb: (status: CppLanguageStatus) => void): () => void
    format(model: Monaco.editor.ITextModel): Promise<Monaco.languages.TextEdit[]>
    exportUsage(): CompletionUsage
    importUsage(usage: unknown): void
    dispose(): void
}
export interface CppLanguageOptions {
    getSettings(): {
        semanticCompletion: boolean
        liveDiagnostics: boolean
        flags: string
        completion?: Partial<CompletionOptions>
    }
}
interface CompletionCache {
    version: number
    line: number
    anchor: number
    prefix: string
    access: CompletionContext['access']
    before: string
    after: string
    items: LspCompletionItem[]
    incomplete: boolean
}

let serviceId = 0
export const COMPLETION_BUDGET_MS = 150
interface Document {
    completionEpoch: number
    model: Monaco.editor.ITextModel
    path: string
    uri: string
    open: boolean
    indexVersion: number
    identifiers: Identifier[]
    listeners: Monaco.IDisposable[]
    requests: Map<string, RequestHandle<unknown>>
    completion?: CompletionCache
    modelMemory: ModelMemory
    diagnosticTimer?: ReturnType<typeof setTimeout>
    diagnosticEpoch: number
    diagnostics?: { version?: number; items: LspDiagnostic[] }
}

/** One service per editor workspace/window; providers handle only explicitly attached models. */
export function createCppLanguageService(
    monaco: Pick<typeof Monaco, 'languages' | 'editor' | 'MarkerSeverity'>,
    api: IterApi,
    opts: CppLanguageOptions
): CppLanguageService {
    const documents = new Map<Monaco.editor.ITextModel, Document>()
    const statusListeners = new Set<(status: CppLanguageStatus) => void>()
    const disposables: Monaco.IDisposable[] = []
    let state: CppLanguageStatus = 'starting'
    let disposed = false,
        hoverEnabled = true,
        ready = false,
        epoch = 0
    let root = '',
        started = false
    let modelRequestId = 0
    let clangdLegend: SemanticLegend | undefined
    const semanticListeners = new Set<() => void>()
    let settings = { ...opts.getSettings() }
    const rpc = new LspClient(api.lsp, notification)
    const usage = new CompletionUsageStore()
    const acceptCommand = `iter.cpp.completion.accept.${++serviceId}`
    disposables.push(
        monaco.editor.registerCommand(
            acceptCommand,
            (_accessor, key: string, modelUri: string, userSnippet: boolean, appendedParentheses: boolean) => {
                if (disposed) return
                if (opts.getSettings().completion?.recordUsage !== false) usage.record(key)
                for (const editor of monaco.editor.getEditors()) {
                    if (!editor.hasTextFocus() || editor.getModel()?.uri.toString() !== modelUri) continue
                    // Monaco otherwise merges a completion into the previous snippet session. Cancel
                    // that session (and its mirrored selections) after accepting a semantic completion.
                    const controller = editor.getContribution<
                        Monaco.editor.IEditorContribution & { isInSnippet(): boolean }
                    >('snippetController2')
                    if (controller?.isInSnippet() && (!userSnippet || (editor.getSelections()?.length ?? 0) > 1)) {
                        editor.trigger('iter.cpp.completion', 'leaveSnippet', {})
                    }
                    if (appendedParentheses) trackCompletionParentheses(editor)
                }
            }
        )
    )
    const kinds = monaco.languages.CompletionItemKind
    const categoryKinds: Record<CompletionCategory, Monaco.languages.CompletionItemKind> = {
        keyword: kinds.Keyword,
        type: kinds.Class,
        function: kinds.Function,
        variable: kinds.Variable,
        constant: kinds.Constant,
        snippet: kinds.Snippet,
        member: kinds.Method,
        property: kinds.Field,
        file: kinds.File,
        folder: kinds.Folder
    }

    function setStatus(next: CppLanguageStatus): void {
        if (disposed || state === next) return
        state = next
        for (const listener of statusListeners) listener(next)
    }

    function clearMarkers(document: Document): void {
        monaco.editor.setModelMarkers(document.model, 'cpp', [])
    }

    function cancelRequests(document: Document): void {
        for (const request of document.requests.values()) request.cancel()
        document.requests.clear()
    }

    function offline(next: CppLanguageStatus): void {
        ready = false
        ++epoch
        rpc.reset()
        for (const document of documents.values()) {
            document.open = false
            document.completion = undefined
            document.diagnostics = undefined
            cancelRequests(document)
            clearMarkers(document)
            scheduleDiagnostics(document)
        }
        setStatus(next)
    }

    function notification(method: string, params: any): void {
        if (disposed) return
        if (method === '$/iter/status') {
            if (params?.state === 'restarted') {
                void initialize()
                return
            }
            offline(params?.state === 'starting' ? 'starting' : 'fallback')
        } else if (method === 'textDocument/publishDiagnostics') {
            syncSettings()
            const document = [...documents.values()].find((item) => uriKey(item.uri) === uriKey(params?.uri ?? ''))
            if (!document || !ready) return
            if (typeof params.version === 'number' && params.version !== document.model.getVersionId()) return
            document.diagnostics = { version: params.version, items: params.diagnostics ?? [] }
            applyDiagnostics(document)
        }
    }

    function applyDiagnostics(document: Document): void {
        const diagnostics = document.diagnostics
        if (
            !settings.liveDiagnostics ||
            !diagnostics ||
            (diagnostics.version !== undefined && diagnostics.version !== document.model.getVersionId())
        )
            return
        const severity = [
            monaco.MarkerSeverity.Error,
            monaco.MarkerSeverity.Error,
            monaco.MarkerSeverity.Warning,
            monaco.MarkerSeverity.Info,
            monaco.MarkerSeverity.Hint
        ]
        monaco.editor.setModelMarkers(
            document.model,
            'cpp',
            diagnostics.items.map((diagnostic) => ({
                ...monacoRange(diagnostic.range),
                severity: severity[diagnostic.severity ?? 1] ?? monaco.MarkerSeverity.Info,
                message: diagnostic.message,
                source: diagnostic.source ?? 'clangd',
                code: diagnostic.code?.toString()
            }))
        )
    }

    function syncSettings(): void {
        if (disposed) return
        const next = { ...opts.getSettings() }
        const flagsChanged = settings.flags !== next.flags
        const diagnosticsChanged = settings.liveDiagnostics !== next.liveDiagnostics
        const semanticChanged = settings.semanticCompletion !== next.semanticCompletion
        const modelChanged = settings.completion?.model !== next.completion?.model
        settings = next
        if (modelChanged) void api.model?.warmup().catch(() => {})
        if (ready && flagsChanged)
            rpc.notify('workspace/didChangeConfiguration', { settings: { iter: { flags: settings.flags } } })
        for (const document of documents.values()) {
            if (flagsChanged || semanticChanged) {
                cancelRequests(document)
                document.completion = undefined
            }
            if (flagsChanged || diagnosticsChanged) {
                if (flagsChanged) document.diagnostics = undefined
                ++document.diagnosticEpoch
                clearTimeout(document.diagnosticTimer)
                clearMarkers(document)
                if (settings.liveDiagnostics && !ready) scheduleDiagnostics(document)
                else if (settings.liveDiagnostics) applyDiagnostics(document)
            }
        }
    }

    async function initialize(): Promise<void> {
        if (disposed) return
        const generation = ++epoch
        ready = false
        rpc.reset()
        const result = await rpc.request(
            'initialize',
            {
                processId: null,
                clientInfo: { name: APP_NAME, version: '0.1' },
                rootUri: sourceUri(root),
                capabilities: {
                    general: { positionEncodings: ['utf-16'] },
                    textDocument: {
                        synchronization: { dynamicRegistration: false, didSave: false },
                        completion: {
                            completionItem: {
                                snippetSupport: false,
                                documentationFormat: ['markdown', 'plaintext'],
                                labelDetailsSupport: true
                            },
                            contextSupport: true
                        },
                        hover: { contentFormat: ['markdown', 'plaintext'] },
                        signatureHelp: {
                            signatureInformation: {
                                documentationFormat: ['markdown', 'plaintext'],
                                parameterInformation: { labelOffsetSupport: true }
                            }
                        },
                        publishDiagnostics: { versionSupport: true },
                        semanticTokens: CLIENT_CAPABILITY
                    },
                    workspace: { configuration: false, workspaceFolders: false }
                },
                initializationOptions: { clangdFileStatus: false, fallbackFlags: ['-std=c++17'] }
            },
            12000
        ).promise
        if (disposed || generation !== epoch) return
        if (!result) {
            offline('fallback')
            return
        }
        clangdLegend = (result as { capabilities?: { semanticTokensProvider?: { legend?: SemanticLegend } } })
            .capabilities?.semanticTokensProvider?.legend
        rpc.notify('initialized', {})
        ready = true
        settings = { ...opts.getSettings() }
        rpc.notify('workspace/didChangeConfiguration', { settings: { iter: { flags: settings.flags } } })
        for (const document of documents.values()) {
            ++document.diagnosticEpoch
            clearTimeout(document.diagnosticTimer)
            document.open = false
            open(document)
        }
        setStatus('clangd')
        for (const listener of semanticListeners) listener()
    }

    async function start(sourcePath: string): Promise<void> {
        if (started || disposed) return
        started = true
        root = parentDirectory(sourcePath)
        const generation = epoch
        let ok = false
        try {
            ok = await api.lsp.start(root)
        } catch {
            /* fallback syntax checking remains available */
        }
        if (disposed) {
            void api.lsp.stop().catch(() => {})
            return
        }
        if (generation !== epoch) return
        if (ok) await initialize()
        else offline('fallback')
    }

    function open(document: Document): void {
        if (!ready || document.open) return
        document.open = true
        rpc.notify('textDocument/didOpen', {
            textDocument: {
                uri: document.uri,
                languageId: 'cpp',
                version: document.model.getVersionId(),
                text: document.model.getValue()
            }
        })
        // clangd's first completion parses the headers (~800 ms for bits/stdc++.h) and didOpen alone does not
        // pay that cost. Do it now, at the end of the file, so the user's first keystroke finds it warm.
        const end = document.model.getPositionAt(document.model.getValue().length)
        void rpc
            .request('textDocument/completion', {
                textDocument: { uri: document.uri },
                position: { line: end.lineNumber - 1, character: end.column - 1 },
                context: { triggerKind: 1 }
            })
            .promise.catch(() => {})
    }

    function scheduleDiagnostics(document: Document): void {
        clearTimeout(document.diagnosticTimer)
        const generation = ++document.diagnosticEpoch
        if (!settings.liveDiagnostics || ready || disposed) return
        document.diagnosticTimer = setTimeout(() => {
            const version = document.model.getVersionId(),
                sourcePath = document.path
            void api.judge
                .syntaxCheck(sourcePath, document.model.getValue())
                .then((diagnostics) => {
                    if (
                        disposed ||
                        !documents.has(document.model) ||
                        ready ||
                        !opts.getSettings().liveDiagnostics ||
                        generation !== document.diagnosticEpoch ||
                        document.model.getVersionId() !== version ||
                        document.path !== sourcePath
                    )
                        return
                    const severities = {
                        error: monaco.MarkerSeverity.Error,
                        warning: monaco.MarkerSeverity.Warning,
                        info: monaco.MarkerSeverity.Info,
                        hint: monaco.MarkerSeverity.Hint
                    }
                    monaco.editor.setModelMarkers(
                        document.model,
                        'cpp',
                        diagnostics
                            .filter(
                                (diagnostic) =>
                                    !diagnostic.file || uriKey(sourceUri(diagnostic.file)) === uriKey(document.uri)
                            )
                            .map((diagnostic) => ({
                                startLineNumber: diagnostic.line,
                                startColumn: diagnostic.column,
                                endLineNumber: diagnostic.endLine ?? diagnostic.line,
                                endColumn: diagnostic.endColumn ?? diagnostic.column + 1,
                                message: diagnostic.message,
                                severity: severities[diagnostic.severity],
                                source: diagnostic.source ?? 'g++'
                            }))
                    )
                })
                .catch(() => {
                    /* The judge IPC may not be installed yet. */
                })
        }, 700)
    }

    function request<T>(
        document: Document,
        key: string,
        method: string,
        params: unknown,
        token: Monaco.CancellationToken
    ): RequestHandle<T> {
        document.requests.get(key)?.cancel()
        const handle = rpc.request<T>(method, params)
        document.requests.set(key, handle as RequestHandle<unknown>)
        const subscription = token.onCancellationRequested(() => handle.cancel())
        if (token.isCancellationRequested) handle.cancel()
        void handle.promise.finally(() => {
            subscription.dispose()
            if (document.requests.get(key) === handle) document.requests.delete(key)
        })
        return handle
    }

    function completionItems(
        candidates: Candidate[],
        range: Monaco.IRange,
        currentSemanticRange: boolean,
        model: Monaco.editor.ITextModel
    ): Monaco.languages.CompletionItem[] {
        return candidates.map((candidate, index) => {
            const edit = candidate.semantic?.textEdit
            return {
                label: candidate.name,
                kind: categoryKinds[candidate.category],
                insertText: candidate.insertText,
                insertTextRules: candidate.snippet
                    ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                    : undefined,
                detail: candidate.detail,
                documentation: candidate.semantic?.documentation
                    ? { value: markdown(candidate.semantic.documentation), isTrusted: false }
                    : undefined,
                sortText: index.toString().padStart(5, '0'),
                filterText: candidate.filterText,
                command: {
                    id: acceptCommand,
                    title: 'Accept completion',
                    arguments: [
                        candidate.usageKey,
                        model.uri.toString(),
                        candidate.category === 'snippet',
                        candidate.snippet && candidate.category !== 'snippet' && candidate.insertText.endsWith('($0)')
                    ]
                },
                range:
                    currentSemanticRange && edit
                        ? 'range' in edit
                            ? monacoRange(edit.range)
                            : { insert: monacoRange(edit.insert), replace: monacoRange(edit.replace) }
                        : range,
                additionalTextEdits: currentSemanticRange
                    ? candidate.semantic?.additionalTextEdits?.map((item) => ({
                          range: monacoRange(item.range),
                          text: item.newText
                      }))
                    : undefined
            }
        })
    }

    function completionResult(result: LspCompletionItem[] | LspCompletionList | undefined): {
        items: LspCompletionItem[]
        incomplete: boolean
    } {
        if (!result) return { items: [], incomplete: true }
        if (Array.isArray(result)) return { items: result, incomplete: false }
        const defaults = result.itemDefaults
        return {
            incomplete: !!result.isIncomplete,
            items: result.items.map((item) => {
                if (!defaults) return item
                const range = defaults.editRange
                return {
                    ...item,
                    insertTextFormat: item.insertTextFormat ?? defaults.insertTextFormat,
                    textEdit:
                        item.textEdit ??
                        (range
                            ? 'start' in range
                                ? { range, newText: item.insertText ?? item.label }
                                : { ...range, newText: item.insertText ?? item.label }
                            : undefined)
                }
            })
        }
    }

    /**
     * clangd needs a few hundred ms for its first reply after a file opens or its leading `#include`/`#define`
     * lines change. A reply that misses COMPLETION_BUDGET_MS is cached; re-open the list from it, otherwise
     * the user sees nothing until the next keystroke.
     */
    function retriggerSuggest(
        model: Monaco.editor.ITextModel,
        document: Document,
        version: number,
        position: Monaco.Position
    ): void {
        if (
            disposed ||
            model.isDisposed() ||
            documents.get(model) !== document ||
            model.getVersionId() !== version ||
            document.completion?.version !== version
        )
            return
        const editor = monaco.editor
            .getEditors?.()
            .find((candidate) => candidate.getModel() === model && candidate.hasTextFocus())
        const at = editor?.getPosition()
        if (editor && at && at.lineNumber === position.lineNumber && at.column === position.column)
            editor.trigger('iter.completion', 'editor.action.triggerSuggest', {})
    }

    disposables.push(
        monaco.languages.registerCompletionItemProvider('cpp', {
            triggerCharacters: ['.', '>', ':', '<', '"', '/', '\\'],
            async provideCompletionItems(model, position, trigger, token) {
                const document = documents.get(model)
                if (!document || disposed || token.isCancellationRequested) return { suggestions: [] }
                const completionEpoch = ++document.completionEpoch
                syncSettings()
                const options = completionOptions(settings.completion)
                const text = model.getValue()
                const context = completionContext(text, model.getOffsetAt(position))
                const { prefix, access, start: anchor } = context
                // Monaco's Invoke also represents quick suggestions. The UI must disable quickSuggestions
                // when showCompletionWhileInput is false, preserving explicit Ctrl+Space (Invoke = 0).
                if (
                    access === 'none' ||
                    (!options.showCompletionWhileInput && trigger.triggerKind !== 0) ||
                    (access === 'plain' && prefix.length < options.minCharRequired)
                ) {
                    document.requests.get('completion')?.cancel()
                    return { suggestions: [] }
                }
                const rank = (extra: Candidate[], semantic: Candidate[]): Candidate[] =>
                    pinSyntax(rankCandidates(extra, semantic, options, usage), context)
                const start = model.getPositionAt(anchor)
                const range = {
                    startLineNumber: position.lineNumber,
                    endLineNumber: position.lineNumber,
                    startColumn: start.column,
                    endColumn: position.column
                }
                const supplemental = supplementalCandidates(context, options)
                if (!ready || !settings.semanticCompletion) {
                    if (access === 'plain' && document.indexVersion !== model.getVersionId()) {
                        document.identifiers = indexIdentifiers(text)
                        document.indexVersion = model.getVersionId()
                    }
                    return {
                        suggestions: completionItems(
                            rank(fallbackCandidates(context, document.identifiers, options), []),
                            range,
                            false,
                            model
                        )
                    }
                }
                const version = model.getVersionId()
                const finish = async (items: LspCompletionItem[], current: boolean, incomplete: boolean) => {
                    let candidates = rank(supplemental, semanticCandidates(items, context, options))
                    if (options.model)
                        candidates = await modelRank(
                            api,
                            candidates,
                            items,
                            {
                                id: `${acceptCommand}:${++modelRequestId}`,
                                source: text,
                                cursor: context.offset,
                                prefix,
                                flags: settings.flags
                            },
                            token,
                            { key: `${anchor}|${access}|${before}|${after}`, memory: document.modelMemory }
                        ).then((ranked) => pinSyntax(ranked, context))
                    if (
                        disposed ||
                        token.isCancellationRequested ||
                        model.isDisposed() ||
                        model.getVersionId() !== version ||
                        documents.get(model) !== document ||
                        document.completionEpoch !== completionEpoch
                    )
                        return { suggestions: [] }
                    if (options.model && opts.getSettings().completion?.model !== true)
                        candidates = rank(supplemental, semanticCandidates(items, context, options))
                    return { suggestions: completionItems(candidates, range, current, model), incomplete }
                }
                const cache = document.completion
                // Never reuse a list across edits to the surrounding program, include path, or access kind.
                const before = text.slice(0, anchor),
                    after = text.slice(context.offset)
                const usableCache =
                    cache &&
                    cache.line === position.lineNumber &&
                    cache.anchor === anchor &&
                    cache.access === access &&
                    prefix.startsWith(cache.prefix) &&
                    cache.before === before &&
                    cache.after === after
                if (usableCache && cache.version === version && cache.prefix === prefix && !cache.incomplete) {
                    return finish(cache.items, true, false)
                }
                const handle = request<LspCompletionItem[] | LspCompletionList>(
                    document,
                    'completion',
                    'textDocument/completion',
                    {
                        textDocument: { uri: document.uri },
                        position: lspPosition(position),
                        context: {
                            triggerKind: trigger.triggerKind === 2 ? 3 : trigger.triggerCharacter ? 2 : 1,
                            ...(trigger.triggerCharacter ? { triggerCharacter: trigger.triggerCharacter } : {})
                        }
                    },
                    token
                )
                const response = handle.promise.then((result) => {
                    if (
                        result &&
                        !disposed &&
                        documents.get(model) === document &&
                        model.getVersionId() === version &&
                        document.open
                    ) {
                        document.completion = {
                            ...completionResult(result),
                            version,
                            anchor,
                            line: position.lineNumber,
                            prefix,
                            access,
                            before,
                            after
                        }
                    }
                    return result
                })
                let timer: ReturnType<typeof setTimeout> | undefined
                const result = await Promise.race([
                    response,
                    new Promise<undefined>((resolve) => {
                        timer = setTimeout(() => resolve(undefined), COMPLETION_BUDGET_MS)
                    })
                ])
                clearTimeout(timer)
                if (!result)
                    void response.then(
                        (late) => {
                            if (late) retriggerSuggest(model, document, version, position)
                        },
                        () => {}
                    )
                if (
                    token.isCancellationRequested ||
                    model.isDisposed() ||
                    model.getVersionId() !== version ||
                    documents.get(model) !== document
                )
                    return { suggestions: [] }
                const parsed = result
                    ? completionResult(result)
                    : { items: usableCache ? cache.items : [], incomplete: true }
                return finish(parsed.items, !!result, parsed.incomplete)
            }
        })
    )

    disposables.push(
        monaco.languages.registerDocumentSemanticTokensProvider('cpp', {
            getLegend: () => ITER_LEGEND,
            onDidChange: (listener) => {
                semanticListeners.add(listener as () => void)
                return {
                    dispose: () => {
                        semanticListeners.delete(listener as () => void)
                    }
                }
            },
            async provideDocumentSemanticTokens(model, _lastResultId, token) {
                const document = available(model)
                if (!document || !clangdLegend) return null
                const version = model.getVersionId()
                const result = await request<{ data?: number[] }>(
                    document,
                    'semantic',
                    'textDocument/semanticTokens/full',
                    { textDocument: { uri: document.uri } },
                    token
                ).promise
                if (!result?.data || model.isDisposed() || version !== model.getVersionId()) return null
                return { data: remapSemanticTokens(result.data, clangdLegend) }
            },
            releaseDocumentSemanticTokens() {}
        })
    )

    // clangd can hang without exiting, and after repeated crashes the automatic retries give up. Check
    // that it answers, and bring it back, instead of leaving the user without completion until restart.
    const WATCH_MS = 15_000,
        REVIVE_MS = 60_000
    let probing = false,
        misses = 0,
        lastRevive = 0
    async function watch(): Promise<void> {
        if (disposed || probing || !started || documents.size === 0) return
        probing = true
        try {
            if (state === 'clangd' && ready) {
                if (await rpc.probe(6000)) {
                    misses = 0
                    return
                }
                if (++misses < 2) return
                misses = 0
                await api.lsp.restart() // main announces 'restarted' and the client initialises again
            } else if (state === 'fallback' && Date.now() - lastRevive >= REVIVE_MS) {
                lastRevive = Date.now()
                if (await api.lsp.restart()) await initialize()
            }
        } catch {
            /* try again on the next tick */
        } finally {
            probing = false
        }
    }
    const watchdog = setInterval(() => {
        void watch()
    }, WATCH_MS)
    disposables.push({ dispose: () => clearInterval(watchdog) })

    function available(model: Monaco.editor.ITextModel): Document | undefined {
        syncSettings()
        return !disposed && ready ? documents.get(model) : undefined
    }

    disposables.push(
        monaco.languages.registerHoverProvider('cpp', {
            async provideHover(model, position, token) {
                const document = available(model)
                if (!document || !hoverEnabled) return null
                const version = model.getVersionId()
                const result = await request<{ contents: unknown; range?: LspRange }>(
                    document,
                    'hover',
                    'textDocument/hover',
                    { textDocument: { uri: document.uri }, position: lspPosition(position) },
                    token
                ).promise
                if (!result || !hoverEnabled || model.isDisposed() || version !== model.getVersionId()) return null
                const value = markdown(result.contents).slice(0, 8000)
                return value
                    ? {
                          contents: [{ value, isTrusted: false }],
                          range: result.range ? monacoRange(result.range) : undefined
                      }
                    : null
            }
        })
    )

    disposables.push(
        monaco.languages.registerSignatureHelpProvider('cpp', {
            signatureHelpTriggerCharacters: ['(', ','],
            signatureHelpRetriggerCharacters: [',', ')'],
            async provideSignatureHelp(model, position, token) {
                const document = available(model)
                if (!document) return null
                const result = await request<{
                    signatures: {
                        label: string
                        documentation?: unknown
                        parameters?: { label: string | [number, number]; documentation?: unknown }[]
                        activeParameter?: number
                    }[]
                    activeSignature?: number
                    activeParameter?: number
                }>(
                    document,
                    'signature',
                    'textDocument/signatureHelp',
                    { textDocument: { uri: document.uri }, position: lspPosition(position) },
                    token
                ).promise
                if (!result?.signatures.length) return null
                return {
                    value: {
                        signatures: result.signatures.map((signature) => ({
                            ...signature,
                            documentation: markdown(signature.documentation),
                            parameters: (signature.parameters ?? []).map((parameter) => ({
                                ...parameter,
                                documentation: markdown(parameter.documentation)
                            }))
                        })),
                        activeSignature: result.activeSignature ?? 0,
                        activeParameter: result.activeParameter ?? 0
                    },
                    dispose() {}
                }
            }
        })
    )

    disposables.push(
        monaco.languages.registerDefinitionProvider('cpp', {
            async provideDefinition(model, position, token) {
                const document = available(model)
                if (!document) return null
                type Location = { uri: string; range: LspRange } | { targetUri: string; targetSelectionRange: LspRange }
                const result = await request<Location | Location[]>(
                    document,
                    'definition',
                    'textDocument/definition',
                    { textDocument: { uri: document.uri }, position: lspPosition(position) },
                    token
                ).promise
                return (Array.isArray(result) ? result : result ? [result] : []).flatMap((location) => {
                    const uri = 'uri' in location ? location.uri : location.targetUri
                    return uriKey(uri) === uriKey(document.uri)
                        ? [
                              {
                                  uri: model.uri,
                                  range: monacoRange(
                                      'range' in location ? location.range : location.targetSelectionRange
                                  )
                              }
                          ]
                        : []
                })
            }
        })
    )

    async function format(
        model: Monaco.editor.ITextModel,
        options: Monaco.languages.FormattingOptions,
        token: Monaco.CancellationToken,
        range?: Monaco.IRange
    ): Promise<Monaco.languages.TextEdit[]> {
        const document = documents.get(model)
        if (!document) return []
        const sourcePath = document.path
        return formattingEdits(
            model,
            sourcePath,
            api,
            ready && document.open
                ? async () => {
                      const result = await request<LspTextEdit[]>(
                          document,
                          'format',
                          range ? 'textDocument/rangeFormatting' : 'textDocument/formatting',
                          {
                              textDocument: { uri: document.uri },
                              options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
                              // The main bridge uses this snapshot for an isolated clangd formatting document.
                              iterSource: model.getValue(),
                              ...(range
                                  ? {
                                        range: {
                                            start: {
                                                line: range.startLineNumber - 1,
                                                character: range.startColumn - 1
                                            },
                                            end: { line: range.endLineNumber - 1, character: range.endColumn - 1 }
                                        }
                                    }
                                  : {})
                          },
                          token
                      ).promise
                      return result?.map((edit) => ({ range: monacoRange(edit.range), text: edit.newText }))
                  }
                : undefined,
            token,
            range,
            () => !disposed && documents.get(model) === document && document.path === sourcePath
        )
    }

    disposables.push(
        monaco.languages.registerDocumentFormattingEditProvider('cpp', {
            provideDocumentFormattingEdits: (model, options, token) => format(model, options, token)
        })
    )
    disposables.push(
        monaco.languages.registerDocumentRangeFormattingEditProvider('cpp', {
            provideDocumentRangeFormattingEdits: (model, range, options, token) => format(model, options, token, range)
        })
    )

    disposables.push(
        monaco.languages.registerDocumentHighlightProvider('cpp', {
            async provideDocumentHighlights(model, position, token) {
                const document = available(model)
                if (!document) return []
                const result = await request<{ range: LspRange; kind?: number }[]>(
                    document,
                    'highlights',
                    'textDocument/documentHighlight',
                    { textDocument: { uri: document.uri }, position: lspPosition(position) },
                    token
                ).promise
                const kinds = [
                    monaco.languages.DocumentHighlightKind.Text,
                    monaco.languages.DocumentHighlightKind.Text,
                    monaco.languages.DocumentHighlightKind.Read,
                    monaco.languages.DocumentHighlightKind.Write
                ]
                return (result ?? []).map((highlight) => ({
                    range: monacoRange(highlight.range),
                    kind: kinds[highlight.kind ?? 1] ?? monaco.languages.DocumentHighlightKind.Text
                }))
            }
        })
    )

    function detach(model: Monaco.editor.ITextModel): void {
        const document = documents.get(model)
        if (!document) return
        if (document.open) rpc.notify('textDocument/didClose', { textDocument: { uri: document.uri } })
        documents.delete(model)
        ++document.diagnosticEpoch
        clearTimeout(document.diagnosticTimer)
        cancelRequests(document)
        for (const listener of document.listeners) listener.dispose()
        clearMarkers(document)
    }

    function attach(model: Monaco.editor.ITextModel, sourcePath: string): void {
        if (disposed || model.isDisposed()) return
        if (documents.get(model)?.path === sourcePath) return
        detach(model)
        const document: Document = {
            model,
            path: sourcePath,
            uri: sourceUri(sourcePath),
            open: false,
            indexVersion: -1,
            identifiers: [],
            requests: new Map(),
            listeners: [],
            diagnosticEpoch: 0,
            completionEpoch: 0,
            modelMemory: {}
        }
        documents.set(model, document)
        document.listeners.push(
            model.onDidChangeContent((event) => {
                syncSettings()
                cancelRequests(document)
                if (document.open && ready)
                    rpc.notify('textDocument/didChange', {
                        textDocument: { uri: document.uri, version: model.getVersionId() },
                        // Monaco ranges refer to the previous version; descending edits preserve their positions.
                        contentChanges: [...event.changes]
                            .sort((a, b) => b.rangeOffset - a.rangeOffset)
                            .map((change) => ({
                                range: {
                                    start: {
                                        line: change.range.startLineNumber - 1,
                                        character: change.range.startColumn - 1
                                    },
                                    end: { line: change.range.endLineNumber - 1, character: change.range.endColumn - 1 }
                                },
                                rangeLength: change.rangeLength,
                                text: change.text
                            }))
                    })
                scheduleDiagnostics(document)
            }),
            model.onWillDispose(() => detach(model))
        )
        open(document)
        scheduleDiagnostics(document)
        void start(sourcePath)
    }

    const settingsTimer = setInterval(syncSettings, 250)
    return {
        format: (model) => format(model, model.getOptions(), formattingToken),
        attach,
        detach,
        exportUsage: () => usage.exportUsage(),
        importUsage: (value) => usage.importUsage(value),
        rename(model, newPath) {
            if (documents.has(model)) {
                detach(model)
                attach(model, newPath)
            }
        },
        setHoverEnabled(enabled) {
            hoverEnabled = enabled
            if (!enabled) for (const document of documents.values()) document.requests.get('hover')?.cancel()
        },
        status: () => state,
        onStatus(cb) {
            statusListeners.add(cb)
            cb(state)
            return () => statusListeners.delete(cb)
        },
        dispose() {
            if (disposed) return
            for (const model of [...documents.keys()]) detach(model)
            disposed = true
            ++epoch
            clearInterval(settingsTimer)
            for (const disposable of disposables) disposable.dispose()
            statusListeners.clear()
            rpc.dispose()
            void api.lsp.stop().catch(() => {})
        }
    }
}
