import type { CheckerValue } from './problem'

const numberToken = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i
export function equalToken(actual: string, expected: string, value: CheckerValue): boolean {
    if (value === 'yesno') return actual.toLowerCase() === expected.toLowerCase()
    if (value.startsWith('float') && numberToken.test(actual) && numberToken.test(expected)) {
        const x = Number(actual),
            y = Number(expected),
            epsilon = 10 ** -Number(value.slice(5))
        return Number.isFinite(x) && Number.isFinite(y)
            ? Math.abs(x - y) <= epsilon * Math.max(1, Math.abs(y))
            : actual === expected
    }
    return actual === expected
}
export function equalLine(actual: string, expected: string, value: CheckerValue): boolean {
    if (actual === expected) return true
    if (value === 'text') return false
    const left = actual.split(/(\s+)/),
        right = expected.split(/(\s+)/)
    return (
        left.length === right.length &&
        left.every((part, i) => (i % 2 ? part === right[i] : equalToken(part, right[i], value)))
    )
}
