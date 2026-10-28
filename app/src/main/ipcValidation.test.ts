import { describe, expect, it } from 'vitest'
import { validateIpcArguments } from './ipcValidation'

describe('IPC transport validation', () => {
    it('rejects malformed writes and unknown directory kinds before any side effect', () => {
        for (const args of [[null, 'code'], ['file.cpp', {}], ['bad\0.cpp', 'code'], ['file.cpp']]) {
            expect(() => validateIpcArguments('fs:writeText', args)).toThrow('Invalid arguments for fs:writeText')
        }
        expect(() => validateIpcArguments('settings:openUserDir', ['unknown'])).toThrow()
        expect(() => validateIpcArguments('problem:writeTest', ['file.cpp', { input: 'new' }])).toThrow()
    })

    it('accepts empty source text, optional arguments and typed requests', () => {
        expect(() => validateIpcArguments('fs:writeText', ['file.cpp', ''])).not.toThrow()
        expect(() =>
            validateIpcArguments('fs:writeText', ['file.cpp', '', { expected: null, confirmOverwrite: true }])
        ).not.toThrow()
        expect(() => validateIpcArguments('fs:writeText', ['file.cpp', '', { expected: {} }])).toThrow()
        expect(() => validateIpcArguments('fs:writeText', ['file.cpp', '', { confirmOverwrite: 'yes' }])).toThrow()
        expect(() => validateIpcArguments('app:recover', ['restart'])).not.toThrow()
        expect(() => validateIpcArguments('app:recover', ['force'])).toThrow()
        expect(() => validateIpcArguments('judge:stop', [])).not.toThrow()
        expect(() => validateIpcArguments('judge:run', [{ sourcePath: 'file.cpp', source: '' }])).not.toThrow()
        expect(() => validateIpcArguments('problem:listTests', ['file.cpp'])).not.toThrow()
    })

    it('does not echo private argument contents in transport errors', () => {
        expect(() => validateIpcArguments('sync:loginToken', ['private-placeholder', 'unexpected'])).toThrow(
            /^Invalid arguments for sync:loginToken$/
        )
    })
})
