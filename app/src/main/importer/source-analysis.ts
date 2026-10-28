export { scanCpp } from '../../shared/cppSource'
import { naturalCompare } from './pairing'
import type { ModeFolder } from '../judge/modes/registry'

/** Detectors share a bounded, read-only view; pure folder analysis never touches disk. */
export function modeFolder(dir: string, files: string[], code: Record<string, string>): ModeFolder {
    const listed = new Set(files)
    return {
        dir,
        files: Object.freeze([...files]),
        peek: (file) => (listed.has(file) && typeof code[file] === 'string' ? code[file].slice(0, 65_536) : undefined)
    }
}

const keywords = new Set([
    'if',
    'for',
    'while',
    'switch',
    'catch',
    'sizeof',
    'alignof',
    'decltype',
    'noexcept',
    'static_assert'
])

/** Balance parameter parentheses so main(argc, argv), function pointers and noexcept work alike. */
export function functionNames(body: string, kind: 'declaration' | 'definition'): Set<string> {
    const names = new Set<string>()
    for (const match of body.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
        if (keywords.has(match[1])) continue
        let position = match.index + match[0].length,
            depth = 1
        while (position < body.length && depth) {
            const char = body[position++]
            if (char === '(') depth++
            else if (char === ')') depth--
        }
        if (depth) continue
        const suffix = body
            .slice(position)
            .match(/^\s*(?:(?:const|volatile|override|final)\b\s*|noexcept(?:\s*\([^)]*\))?\s*|->[^;{]+)*([;{])/)
        if (suffix?.[1] === (kind === 'definition' ? '{' : ';')) names.add(match[1])
    }
    return names
}

export function headerKey(file: string): string {
    return file
        .replaceAll('\\', '/')
        .replace(/^(\.\/)+/, '')
        .toLowerCase()
}

/** Keep reference/brute-force programs available, below likely user solutions. */
export function rankSources(files: string[], problemName: string, modified: Record<string, number>): string[] {
    const rank = (file: string): number => {
        const name = file.replace(/\.cpp$/i, '')
        if (name.toLowerCase() === problemName.toLowerCase()) return 0
        if (/^T\d+$/i.test(name)) return 1
        if (/^(sol|std|brute|bf)/i.test(name)) return 3
        return 2
    }
    return files.sort((a, b) => rank(a) - rank(b) || (modified[b] ?? 0) - (modified[a] ?? 0) || naturalCompare(a, b))
}
