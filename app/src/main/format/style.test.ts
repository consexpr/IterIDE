import { describe, expect, it } from 'vitest'
import { synchronizeIndentation } from './style'

const configuration =
    '---\nLanguage: Cpp\nIndentWidth: 6\nTabWidth: 8\nUseTab: Always\nContinuationIndentWidth: 4\nConstructorInitializerIndentWidth: 4\nBracedInitializerIndentWidth: 6\nBraceWrapping:\n  AfterClass: true\nColumnLimit: 80\n...\n'

describe('editor-controlled formatter indentation', () => {
    it('preserves canonical non-indentation fields and nested options', () => {
        expect(synchronizeIndentation(configuration, { tabSize: 2, insertSpaces: true })).toBe(
            '---\nLanguage: Cpp\nIndentWidth: 2\nTabWidth: 2\nUseTab: Never\nContinuationIndentWidth: 2\nConstructorInitializerIndentWidth: 2\nBracedInitializerIndentWidth: 6\nBraceWrapping:\n  AfterClass: true\nColumnLimit: 80\n...\n'
        )
    })

    it('rejects incomplete tool output instead of silently leaving mixed indentation', () => {
        expect(() => synchronizeIndentation('IndentWidth: 4\n', { tabSize: 2, insertSpaces: false })).toThrow(
            'configuration is missing'
        )
    })
})
