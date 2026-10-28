export type Rgb = [number, number, number]

/** Rests for a while, then a narrow bright band travels from the last character to the first. */
export const SHIMMER = { idleMs: 2200, stepMs: 200, radius: 3 }

export function hexToRgb(hex: string): Rgb {
    const value = parseInt(hex.replace('#', ''), 16)
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

/** Whole-sweep duration: the band holds on each character for stepMs before moving to the previous one. */
export const sweepDuration = (length: number): number => (length + 2 * SHIMMER.radius) * SHIMMER.stepMs

/** Centre of the band as a character index (always whole), or null while the text is resting. */
export function bandCenter(now: number, length: number, offsetMs = 0): number | null {
    const { idleMs, stepMs, radius } = SHIMMER
    const cycle = idleMs + sweepDuration(length)
    const phase = (((now + offsetMs) % cycle) + cycle) % cycle
    if (phase < idleMs) return null
    return length - 1 + radius - Math.floor((phase - idleMs) / stepMs)
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t
]

/** Resting colour is stops[0]; characters near the band blend through stops[1] up to stops[2] at its centre. */
export function charColor(index: number, center: number | null, stops: Rgb[]): Rgb {
    if (center === null) return stops[0]
    const weight = Math.max(0, 1 - Math.abs(index - center) / SHIMMER.radius)
    const eased = weight * weight * (3 - 2 * weight)
    return eased < 0.5 ? mix(stops[0], stops[1], eased * 2) : mix(stops[1], stops[2], (eased - 0.5) * 2)
}

export const css = (color: Rgb): string => `rgb(${color.map(Math.round).join(',')})`
