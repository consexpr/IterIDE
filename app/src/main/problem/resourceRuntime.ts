import { promises as fs } from 'node:fs'
import path from 'node:path'

// Consume comments and character literals as tokens, so their quotes never become file references.
const tokens =
    /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|'(?:\\.|[^'\\\r\n])*'|R"([^ ()\\\t\r\n]{0,16})\(([\s\S]*?)\)\1"|"(?:\\.|[^"\\\r\n])*"/g
function literal(token: string): string | undefined {
    if (token.startsWith('R"')) return /^R"[^ (]*\(([\s\S]*)\)[^ "]*"$/.exec(token)?.[1]
    if (!token.startsWith('"')) return undefined
    try {
        return JSON.parse(token) as string
    } catch {
        return undefined
    }
}
export function resourceStrings(text: string): string[] {
    const names = new Set<string>()
    text.replace(tokens, (token: string, _delimiter, _raw, offset: number) => {
        const value = literal(token)
        const prefix = text.slice(text.lastIndexOf('\n', offset) + 1, offset)
        if (value && (!/^\s*#/.test(prefix) || /^\s*#\s*define\b/.test(prefix)) && !value.includes('\0'))
            names.add(value)
        return token
    })
    return [...names]
}
export function rewriteRuntimeStrings(text: string, mappings: Record<string, string>): string {
    return text.replace(tokens, (token: string) => {
        const value = literal(token)
        return value !== undefined && Object.hasOwn(mappings, value) ? mappings[value] : token
    })
}

export interface ResourceManifest {
    version: 1
    digest: string
    includeDirs: string[]
    assets: Record<string, string>
}
export function bundleRoot(file: string): string | undefined {
    let current = path.resolve(file)
    while (path.dirname(current) !== current) {
        if (/^[a-f\d-]{36}$/i.test(path.basename(current)) && path.basename(path.dirname(current)) === 'resources')
            return current
        current = path.dirname(current)
    }
    return undefined
}
/** Only portable, relative manifest paths are accepted, including when a store was copied from elsewhere. */
export async function resourceContext(files: string[]): Promise<{ flags: string[]; includeDirs: string[] }> {
    const flags: string[] = [],
        includeDirs: string[] = []
    for (const root of new Set(files.map(bundleRoot).filter((file): file is string => !!file))) {
        const file = path.join(root, 'bundle.json')
        const text = await fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined
            throw error
        })
        if (text === undefined) continue // Bundles created before manifests remain readable.
        const data = JSON.parse(text) as ResourceManifest
        const resolve = (relative: string): string => {
            if (
                typeof relative !== 'string' ||
                !relative ||
                path.isAbsolute(relative) ||
                relative.includes('\0') ||
                relative.split(/[\\/]/).some((part) => part === '..' || part.includes(':'))
            )
                throw new Error('无效的缓存资源路径')
            return path.resolve(root, relative)
        }
        if (data.version !== 1 || !Array.isArray(data.includeDirs) || !data.assets || typeof data.assets !== 'object')
            throw new Error('无效的缓存资源清单')
        includeDirs.push(...data.includeDirs.map(resolve))
        for (const [name, relative] of Object.entries(data.assets)) {
            // Existing cached sources still reference the original macro name; never rewrite their contents.
            if (!/^(?:ITER|NAVEN)_RESOURCE_[a-f\d]{16}$/.test(name)) throw new Error('无效的缓存资源标识')
            flags.push('-D' + name + '=' + JSON.stringify(resolve(relative).replaceAll('\\', '/')))
        }
    }
    return { flags, includeDirs: [...new Set(includeDirs)] }
}
