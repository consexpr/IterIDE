/** GCC make depfiles escape whitespace/#/$ and wrap long lines. A drive-letter
 * colon is not a rule separator; the actual separator is followed by whitespace. */
export function parseDepfile(text: string): string[] {
    const joined = text.replace(/\\\r?\n/g, '')
    const separator = /:\s/.exec(joined)
    if (!separator) throw new Error('Compiler produced an invalid dependency file')
    const body = joined.slice(separator.index + 1)
    const files: string[] = []
    let word = ''
    for (let i = 0; i < body.length; i++) {
        const c = body[i]
        if (c === '\\' && /[\s#:$\\]/.test(body[i + 1] ?? '')) word += body[++i]
        else if (c === '$' && body[i + 1] === '$') {
            word += '$'
            i++
        } else if (/\s/.test(c)) {
            if (word) {
                files.push(word)
                word = ''
            }
        } else word += c
    }
    if (word) files.push(word)
    return [...new Set(files)]
}
