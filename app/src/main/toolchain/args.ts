/** Split an argv string without a shell. Windows paths, including UNC paths,
 * retain their backslashes; quotes may group spaces or be escaped literally. */
export function splitArgs(text: string, platform: NodeJS.Platform = process.platform): string[] {
    const args: string[] = []
    let word = '',
        quote = '',
        started = false
    for (let i = 0; i < text.length; i++) {
        const c = text[i]
        if (
            c === '\\' &&
            i + 1 < text.length &&
            (text[i + 1] === '"' ||
                text[i + 1] === "'" ||
                (platform !== 'win32' && text[i + 1] === '\\') ||
                (!quote && /\s/.test(text[i + 1])))
        ) {
            word += text[++i]
            started = true
        } else if (quote) {
            if (c === quote) quote = ''
            else word += c
        } else if (c === '"' || c === "'") {
            quote = c
            started = true
        } else if (/\s/.test(c)) {
            if (started) {
                args.push(word)
                word = ''
                started = false
            }
        } else {
            word += c
            started = true
        }
    }
    if (quote) throw new Error('Unclosed quote in compiler flags or checker arguments')
    if (started) args.push(word)
    return args
}
