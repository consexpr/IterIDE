import type * as Monaco from 'monaco-editor'
import { vi } from 'vitest'
import type { IterApi } from '../../shared/api'
import { createCppLanguageService } from './index'
import type { CompletionOptions } from './options'
import { CLIENT_CAPABILITY } from './semantic'

export const flush = async (): Promise<void> => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
}
export const token: Monaco.CancellationToken = {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose() {} })
}

export function fakeModel(initial: string) {
    let text = initial,
        version = 1,
        disposed = false
    const changes = new Set<(event: any) => void>()
    const disposal = new Set<() => void>()
    const model = {
        uri: { toString: () => 'inmemory://model/1' },
        isDisposed: () => disposed,
        getVersionId: () => version,
        getValue: () => text,
        getOptions: () => ({ tabSize: 4, insertSpaces: true }),
        getPositionAt: (offset: number) => {
            const lines = text.slice(0, offset).split('\n')
            return { lineNumber: lines.length, column: lines.at(-1)!.length + 1 }
        },
        getLineContent: (line: number) => text.split('\n')[line - 1],
        getOffsetAt: (position: Monaco.IPosition) =>
            text
                .split('\n')
                .slice(0, position.lineNumber - 1)
                .reduce((sum, line) => sum + line.length + 1, 0) +
            position.column -
            1,
        getWordUntilPosition: (position: Monaco.IPosition) => {
            const before = text.split('\n')[position.lineNumber - 1].slice(0, position.column - 1)
            const word = /[A-Za-z_0-9]+$/.exec(before)?.[0] ?? ''
            return { word, startColumn: position.column - word.length, endColumn: position.column }
        },
        onDidChangeContent: (callback: (event: any) => void) => {
            changes.add(callback)
            return { dispose: () => changes.delete(callback) }
        },
        onWillDispose: (callback: () => void) => {
            disposal.add(callback)
            return { dispose: () => disposal.delete(callback) }
        }
    }
    return {
        model: model as unknown as Monaco.editor.ITextModel,
        edit(next: string, edits?: any[]) {
            const previous = text
            text = next
            version++
            const lines = previous.split('\n')
            for (const callback of changes)
                callback({
                    changes: edits ?? [
                        {
                            rangeOffset: 0,
                            rangeLength: previous.length,
                            text: next,
                            range: {
                                startLineNumber: 1,
                                startColumn: 1,
                                endLineNumber: lines.length,
                                endColumn: lines.at(-1)!.length + 1
                            }
                        }
                    ]
                })
        },
        position: () => ({ lineNumber: text.split('\n').length, column: text.split('\n').at(-1)!.length + 1 }),
        dispose() {
            for (const callback of disposal) callback()
            disposed = true
        }
    }
}

export function fixture(available = true, transport?: IterApi['lsp']) {
    const listeners = new Set<(message: unknown) => void>()
    const sent: any[] = []
    const providers: Record<string, any> = {}
    const registrations: { dispose: ReturnType<typeof vi.fn> }[] = []
    const markers = vi.fn()
    const commands = new Map<string, (...args: any[]) => void>()
    const editors: any[] = []
    const settings: {
        semanticCompletion: boolean
        liveDiagnostics: boolean
        flags: string
        completion?: Partial<CompletionOptions>
    } = { semanticCompletion: true, liveDiagnostics: true, flags: '-std=c++20' }
    const deliver = (message: unknown): void => {
        for (const listener of listeners) listener(message)
    }
    const respond = (id: number, result: unknown): void => deliver({ jsonrpc: '2.0', id, result })
    const api = {
        model: {
            warmup: vi.fn(async () => {}),
            rank: vi.fn(async (_request: unknown) => null as import('../../shared/model').ModelResult | null),
            cancel: vi.fn()
        },
        lsp: {
            start: vi.fn(async () => available),
            stop: vi.fn(async () => {}),
            restart: vi.fn(async () => available),
            send: vi.fn((message: any) => {
                sent.push(message)
                if (message.method === 'initialize')
                    void Promise.resolve().then(() =>
                        respond(message.id, {
                            capabilities: {
                                semanticTokensProvider: {
                                    legend: {
                                        tokenTypes: CLIENT_CAPABILITY.tokenTypes,
                                        tokenModifiers: CLIENT_CAPABILITY.tokenModifiers
                                    }
                                }
                            }
                        })
                    )
            }),
            onMessage: (callback: (message: unknown) => void) => {
                listeners.add(callback)
                return () => listeners.delete(callback)
            }
        },
        judge: { syntaxCheck: vi.fn(async () => [] as any[]) },
        format: { run: vi.fn(async () => ({ text: 'int x;\n' }) as { text: string } | { error: string }) }
    }
    function register(key: string) {
        return (_language: string, provider: unknown) => {
            providers[key] = provider
            const registration = { dispose: vi.fn() }
            registrations.push(registration)
            return registration
        }
    }
    const monaco = {
        MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
        editor: {
            setModelMarkers: markers,
            getEditors: () => editors,
            registerCommand: (id: string, handler: (...args: any[]) => void) => {
                commands.set(id, handler)
                return { dispose: () => commands.delete(id) }
            }
        },
        languages: {
            CompletionItemKind: {
                Keyword: 17,
                Class: 5,
                Function: 1,
                Variable: 4,
                Constant: 14,
                Snippet: 27,
                Method: 0,
                Field: 3,
                File: 20,
                Folder: 23
            },
            CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
            DocumentHighlightKind: { Text: 0, Read: 1, Write: 2 },
            registerCompletionItemProvider: register('completion'),
            registerHoverProvider: register('hover'),
            registerSignatureHelpProvider: register('signature'),
            registerDefinitionProvider: register('definition'),
            registerDocumentFormattingEditProvider: register('format'),
            registerDocumentRangeFormattingEditProvider: register('rangeFormat'),
            registerDocumentHighlightProvider: register('highlights'),
            registerDocumentSemanticTokensProvider: register('semantic')
        }
    }
    if (transport) api.lsp = transport as unknown as typeof api.lsp
    const service = createCppLanguageService(monaco as unknown as typeof Monaco, api as unknown as IterApi, {
        getSettings: () => settings
    })
    const requests = (method: string): any[] => sent.filter((message) => message.method === method)
    return {
        service,
        api,
        providers,
        settings,
        deliver,
        respond,
        requests,
        markers,
        registrations,
        listeners,
        commands,
        editors
    }
}
