import { expect, it, vi } from 'vitest'
import type * as Monaco from 'monaco-editor/editor/editor.api'
import { registerInlineCompletion } from './inline'
import { activateInlineShortcut } from './inlineControl'
import { aiCompletionSettings } from '../../shared/inlineAi'
import { validateSettingsPatch } from '../../shared/settingsValidation'

function fixture() {
    let provider!: Monaco.languages.InlineCompletionsProvider
    const complete = vi.fn(async () => ({ text: 'x' }))
    let version = 1
    const registration = registerInlineCompletion(
        {
            languages: {
                InlineCompletionTriggerKind: { Automatic: 0, Explicit: 1 },
                registerInlineCompletionsProvider: (
                    _language: string,
                    value: Monaco.languages.InlineCompletionsProvider
                ) => {
                    provider = value
                    return { dispose() {} }
                }
            }
        } as unknown as Pick<typeof Monaco, 'languages'>,
        { inline: { complete, cancel: vi.fn() } },
        () => ({ ai: { enabled: true, apiKey: 'synthetic', model: 'test', effort: '' } })
    )
    const model = {
        getVersionId: () => version,
        isDisposed: () => false,
        getValue: () => 'int ',
        getOffsetAt: () => 4
    } as unknown as Monaco.editor.ITextModel
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }
    return {
        complete,
        registration,
        change: () => version++,
        run: (triggerKind: 0 | 1) =>
            Promise.resolve(
                provider.provideInlineCompletions(
                    model,
                    { lineNumber: 1, column: 5 } as Monaco.Position,
                    { triggerKind } as Monaco.languages.InlineCompletionContext,
                    token
                )
            )
    }
}

it('ignores typing and sends only one immediate request per explicit shortcut', async () => {
    const f = fixture()
    try {
        await f.run(0)
        await f.run(1)
        expect(f.complete).not.toHaveBeenCalled()
        activateInlineShortcut()
        await f.run(0)
        expect(f.complete).not.toHaveBeenCalled()
        expect((await f.run(1))?.items).toHaveLength(1)
        await f.run(0)
        await f.run(1)
        expect(f.complete).toHaveBeenCalledTimes(1)
        activateInlineShortcut()
        await f.run(1)
        expect(f.complete).toHaveBeenCalledTimes(2)
    } finally {
        f.registration.dispose()
    }
})

it('discards a manual result if the source changes while it is pending', async () => {
    const f = fixture()
    try {
        let resolve!: (value: { text: string }) => void
        f.complete.mockImplementationOnce(() => new Promise((done) => (resolve = done)))
        activateInlineShortcut()
        const pending = f.run(1)
        f.change()
        resolve({ text: 'stale' })
        expect((await pending)?.items).toEqual([])
        await f.run(0)
        expect(f.complete).toHaveBeenCalledTimes(1)
    } finally {
        f.registration.dispose()
    }
})

it('drops legacy automatic mode and delay settings while retaining FIM configuration', () => {
    const legacy = {
        enabled: true,
        apiKey: 'synthetic',
        model: 'test',
        effort: '',
        shortcutMode: 'toggle',
        requestDelayMs: 1500
    }
    const expected = { enabled: true, apiKey: 'synthetic', model: 'test', effort: '' }
    expect(aiCompletionSettings(legacy)).toEqual(expected)
    expect(validateSettingsPatch({ editor: { completion: { ai: legacy } } })).toEqual({
        editor: { completion: { ai: expected } }
    })
})
