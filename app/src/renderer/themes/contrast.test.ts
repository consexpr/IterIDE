import { expect, it } from 'vitest'
import { blend, contrast, hex8, parseColor, readableAlpha } from './contrast'

it('parses the colour syntaxes themes use', () => {
    expect(parseColor('#fff')).toEqual([255, 255, 255])
    expect(parseColor('#16181c')).toEqual([22, 24, 28])
    expect(parseColor('#16181cff')).toEqual([22, 24, 28])
    expect(parseColor('rgba(134,168,231,0.22)')).toEqual([134, 168, 231])
    expect(parseColor('var(--x)')).toBeNull()
    expect(parseColor(undefined)).toBeNull()
})

it('computes WCAG contrast ratios', () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 0)
    expect(contrast([10, 10, 10], [10, 10, 10])).toBe(1)
})

it('keeps text readable by thinning a tint that is too strong', () => {
    const background = parseColor('#0d0f0d')!,
        text = parseColor('#c9ced6')!,
        accent = parseColor('#7ee08a')!
    const alpha = readableAlpha(background, accent, [text], 0.9, 4.5)
    expect(alpha).toBeLessThan(0.9)
    expect(contrast(text, blend(background, accent, alpha))).toBeGreaterThanOrEqual(4.5)
    // A tint that is already readable is left alone.
    expect(readableAlpha(background, accent, [text], 0.1, 4.5)).toBe(0.1)
})

it('writes colours with an alpha channel', () => {
    expect(hex8([255, 0, 128], 0.5)).toBe('#ff008080')
})
