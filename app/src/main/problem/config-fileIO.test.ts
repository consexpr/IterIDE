import { expect, it } from 'vitest'
import { normalize } from './config'

it.each(['freopen', 'manual'] as const)('keeps %s file IO provenance across config normalization', (origin) => {
    const config = normalize('D:/sample.cpp', {
        fileIO: { enabled: true, input: 'sample.in', output: 'sample.out', origin }
    })
    expect(normalize('D:/sample.cpp', config).fileIO).toEqual({
        enabled: true,
        input: 'sample.in',
        output: 'sample.out',
        origin
    })
})
it('keeps legacy file IO unchanged and ignores malformed provenance', () => {
    const io = { enabled: true, input: 'sample.in', output: 'sample.out' }
    expect(normalize('D:/sample.cpp', { fileIO: io }).fileIO).toEqual(io)
    expect(normalize('D:/sample.cpp', { fileIO: { ...io, origin: 'unknown' } }).fileIO).toEqual(io)
})
