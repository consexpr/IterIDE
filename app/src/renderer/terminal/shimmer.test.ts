import { expect, it } from 'vitest'
import { SHIMMER, bandCenter, charColor, hexToRgb, sweepDuration } from './shimmer'

const stops = [hexToRgb('#a855f7'), hexToRgb('#f472b6'), hexToRgb('#ffffff')]

it('rests for a while before each sweep', () => {
    expect(bandCenter(0, 20)).toBeNull()
    expect(bandCenter(SHIMMER.idleMs - 1, 20)).toBeNull()
    expect(bandCenter(SHIMMER.idleMs + 1, 20)).not.toBeNull()
})

it('steps one character at a time from the last character to the first', () => {
    const length = 20
    const start = bandCenter(SHIMMER.idleMs + 1, length)!
    expect(start).toBe(length - 1 + SHIMMER.radius)
    // Holds still within a step, then moves exactly one character.
    expect(bandCenter(SHIMMER.idleMs + SHIMMER.stepMs - 1, length)).toBe(start)
    expect(bandCenter(SHIMMER.idleMs + SHIMMER.stepMs, length)).toBe(start - 1)
    const last = bandCenter(SHIMMER.idleMs + sweepDuration(length) - 1, length)!
    expect(last).toBe(-SHIMMER.radius)
    expect(bandCenter(SHIMMER.idleMs + sweepDuration(length), length)).toBeNull()
})

it('only colours characters near the band', () => {
    expect(charColor(5, null, stops)).toEqual(stops[0])
    expect(charColor(10, 10, stops)).toEqual(stops[2])
    expect(charColor(10 + SHIMMER.radius, 10, stops)).toEqual(stops[0])
    expect(charColor(0, 10, stops)).toEqual(stops[0])
})
