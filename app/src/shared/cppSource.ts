// Match literals before examining their contents, including raw strings containing quotes/comments.
const cppTokens =
    /\/\*[\s\S]*?(?:\*\/|$)|\/\/(?:\\\r?\n|[^\n])*|(?:u8|u|U|L)?R"([^\s()\\]{0,16})\([\s\S]*?\)\1"|"(?:\\[\s\S]|[^"\\])*"|(?<!\w)(?:u8|[uUL])?'(?:\\[\s\S]|[^'\\\r\n])*'/g
const blank = (text: string): string => text.replace(/[^\r\n]/g, ' ')

/** A light lexical scan, not a C++ parser: comments/literals cannot impersonate code or includes. */
export function scanCpp(code: string): { body: string; includes: string[]; quotedIncludes: string[] } {
    const uncommented = code.replace(cppTokens, (token) =>
        token.startsWith('//') || token.startsWith('/*') ? blank(token) : token
    )
    const includes: string[] = [],
        quotedIncludes: string[] = []
    const body = uncommented.replace(cppTokens, (token: string, _delimiter: string | undefined, offset: number) => {
        const prefix = uncommented.slice(uncommented.lastIndexOf('\n', offset - 1) + 1, offset)
        if (token.startsWith('"') && /^[\t ]*#\s*include\s*$/.test(prefix)) {
            includes.push(token.slice(1, -1))
            quotedIncludes.push(token.slice(1, -1))
        }
        return blank(token)
    })
    for (const match of body.matchAll(/^\s*#\s*include\s*<([^>\r\n]+)>/gm)) includes.push(match[1])
    // Macro bodies are not function definitions either; include continued directive lines.
    return { body: body.replace(/^[\t ]*#(?:[^\n]*\\\r?\n)*[^\n]*/gm, blank), includes, quotedIncludes }
}
