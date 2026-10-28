export type Rgb = [number, number, number]

/** `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()`; alpha is ignored. Anything else is null. */
export function parseColor(value: string | undefined): Rgb | null {
    if (!value) return null
    const text = value.trim().toLowerCase()
    const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text)?.[1]
    if (hex) {
        const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex
        return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as Rgb
    }
    const fn = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(text)
    return fn ? [Number(fn[1]), Number(fn[2]), Number(fn[3])] : null
}

const channel = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

/** WCAG contrast ratio, 1 (identical) to 21. */
export function contrast(a: Rgb, b: Rgb): number {
    const lum = (c: Rgb): number => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2])
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
}

export const blend = (base: Rgb, over: Rgb, alpha: number): Rgb =>
    [0, 1, 2].map((i) => base[i] + (over[i] - base[i]) * alpha) as Rgb

export function hex8(color: Rgb, alpha: number): string {
    const part = (n: number): string =>
        Math.round(Math.max(0, Math.min(255, n)))
            .toString(16)
            .padStart(2, '0')
    return `#${color.map(part).join('')}${part(alpha * 255)}`
}

/**
 * The largest alpha, up to `alpha`, at which `tint` laid over `background` still keeps every text colour
 * readable. Text must stay above `minimum` against the tinted surface, so a highlight never swallows code.
 */
export function readableAlpha(background: Rgb, tint: Rgb, texts: Rgb[], alpha: number, minimum: number): number {
    let current = alpha
    while (current > 0.06 && texts.some((text) => contrast(text, blend(background, tint, current)) < minimum))
        current *= 0.85
    return current
}
