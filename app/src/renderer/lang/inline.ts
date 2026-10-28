import type * as Monaco from 'monaco-editor/editor/editor.api'
import type { IterApi } from '../../shared/api'
import { aiCompletionSettings, INLINE_MAX_PREFIX, INLINE_MAX_SUFFIX } from '../../shared/inlineAi'
import type { CompletionSettings } from '../../shared/settings'

import { allowInlineRequest } from './inlineControl'
import { beginInlineRequest } from './inlineStatus'

let counter = 0

/** Keep the model from continuing past what belongs at the cursor: trailing blank lines carry nothing. */
export function cleanInline(text: string, suffix: string): string {
    let out = text.replace(/\r\n/g, '\n').replace(/\s+$/, '')
    if (!out.trim()) return ''
    // The model sometimes repeats what already follows the cursor on this line.
    const rest = suffix.split('\n', 1)[0].trim()
    if (rest && out.endsWith(rest)) out = out.slice(0, out.length - rest.length).replace(/\s+$/, '')
    return out
}

/** Ghost text from DeepSeek's FIM endpoint; Monaco shows it dimmed and Tab accepts it. */
export function registerInlineCompletion(
    monaco: Pick<typeof Monaco, 'languages'>,
    api: Pick<IterApi, 'inline'>,
    getSettings: () => Partial<CompletionSettings> | undefined
): Monaco.IDisposable {
    const id = `inline:${++counter}`
    let generation = 0
    const provider = monaco.languages.registerInlineCompletionsProvider('cpp', {
        async provideInlineCompletions(model, position, context, token) {
            // Monaco may ask again after typing; only the user's single trigger may call FIM.
            if (context.triggerKind !== monaco.languages.InlineCompletionTriggerKind.Explicit) return { items: [] }
            if (!allowInlineRequest()) return { items: [] }
            const ai = aiCompletionSettings(getSettings()?.ai)
            if (!ai.enabled || !ai.apiKey) return { items: [] }
            const sequence = ++generation
            const version = model.getVersionId()
            if (token.isCancellationRequested || model.isDisposed()) return { items: [] }
            const offset = model.getOffsetAt(position)
            const text = model.getValue()
            const prefix = text.slice(Math.max(0, offset - INLINE_MAX_PREFIX), offset)
            const suffix = text.slice(offset, offset + INLINE_MAX_SUFFIX)
            if (!prefix.trim()) return { items: [] }
            const finish = beginInlineRequest()
            const subscription = token.onCancellationRequested(() => {
                finish()
                if (sequence === generation) api.inline.cancel(id)
            })
            try {
                const result = await api.inline.complete({ id, prefix, suffix })
                if (
                    token.isCancellationRequested ||
                    sequence !== generation ||
                    model.isDisposed() ||
                    model.getVersionId() !== version ||
                    !result ||
                    !('text' in result)
                )
                    return { items: [] }
                const insertText = cleanInline(result.text, suffix)
                if (!insertText) return { items: [] }
                return {
                    items: [
                        {
                            insertText,
                            range: {
                                startLineNumber: position.lineNumber,
                                startColumn: position.column,
                                endLineNumber: position.lineNumber,
                                endColumn: position.column
                            }
                        }
                    ]
                }
            } catch {
                return { items: [] }
            } finally {
                finish()
                subscription.dispose()
            }
        },
        disposeInlineCompletions() {}
    })
    return {
        dispose() {
            generation++
            api.inline.cancel(id)
            provider.dispose()
        }
    }
}
