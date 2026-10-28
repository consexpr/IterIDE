const MAX_CHARS = 100_000
const MAX_LINES = 2000

/** Bound DOM text independently of file preview settings and pasted content. */
export function testTextPreview(value: string): { text: string; truncated: boolean } {
    let end = Math.min(value.length, MAX_CHARS)
    let lines = 1
    for (let i = 0; i < end; i++) {
        if (value[i] === '\n' || (value[i] === '\r' && value[i + 1] !== '\n')) {
            if (++lines > MAX_LINES) {
                end = i
                break
            }
        }
    }
    // Do not split a UTF-16 surrogate pair at the character boundary.
    if (end < value.length && end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1])) end--
    return { text: value.slice(0, end), truncated: end < value.length }
}
