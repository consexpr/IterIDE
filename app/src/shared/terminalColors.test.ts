import { expect, it } from 'vitest'
import { DEFAULT_TERMINAL_COLORS, terminalColors } from './settings'

it('normalizes terminal sweep colours to three valid stops', () => {
    expect(terminalColors(undefined)).toEqual(DEFAULT_TERMINAL_COLORS)
    expect(terminalColors(['#FF0000', 'red', 5])).toEqual([
        '#ff0000',
        DEFAULT_TERMINAL_COLORS[1],
        DEFAULT_TERMINAL_COLORS[2]
    ])
    expect(terminalColors(['#000000', '#111111', '#222222', '#333333'])).toEqual(['#000000', '#111111', '#222222'])
})
