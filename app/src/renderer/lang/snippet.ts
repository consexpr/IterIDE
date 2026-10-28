export interface SnippetInspection {
    text: string
    tabStops: number[]
    valid: boolean
}

/** Deliberately small supported subset: numbered stops, defaults, choices and escapes.
 * Variables/transforms are rejected rather than creating implicit or mirrored stops.
 */
export function inspectSnippet(body: string): SnippetInspection {
    let at = 0,
        valid = true
    const tabStops: number[] = [],
        values = new Map<number, string>()
    function sequence(nested = false): string {
        let text = ''
        while (at < body.length) {
            const char = body[at++]
            if (char === '}' && nested) return text
            if (char === '\\' && /[$}\\,|]/.test(body[at] ?? '')) {
                text += body[at++]
                continue
            }
            if (char !== '$') {
                text += char
                continue
            }
            const braced = body[at] === '{'
            if (braced) at++
            const number = /^\d+/.exec(body.slice(at))?.[0]
            if (!number) {
                valid = false
                return text
            }
            at += number.length
            const id = Number(number)
            tabStops.push(id)
            let value = values.get(id) ?? ''
            if (braced) {
                const separator = body[at++]
                if (separator === ':') value = sequence(true)
                else if (separator === '|') {
                    let first = '',
                        choosing = true,
                        closed = false
                    while (at < body.length) {
                        const choice = body[at++]
                        if (choice === '\\' && /[\\,|]/.test(body[at] ?? '')) {
                            const escaped = body[at++]
                            if (choosing) first += escaped
                        } else if (choice === '|' && body[at] === '}') {
                            at++
                            closed = true
                            break
                        } else if (choice === ',') choosing = false
                        else if (choosing) first += choice
                    }
                    if (!closed) valid = false
                    value = first
                } else if (separator !== '}') {
                    valid = false
                    return text
                }
            }
            values.set(id, value)
            text += value
        }
        if (nested) valid = false
        return text
    }
    const text = sequence()
    return { text, tabStops, valid: valid && tabStops.every(Number.isSafeInteger) }
}

export function validUserSnippet(body: string): boolean {
    const result = inspectSnippet(body)
    return result.valid && new Set(result.tabStops).size === result.tabStops.length
}

export function plainCompletionText(body: string, format: number | undefined, fallback: string): string {
    if (format !== 2) return body
    const result = inspectSnippet(body)
    return result.valid ? result.text : fallback
}

export function escapeSnippetText(text: string): string {
    return text.replace(/[$}\\]/g, '\\$&')
}
