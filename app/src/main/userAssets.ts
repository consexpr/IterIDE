import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isInside, pluginFilePath } from './plugins/paths'

/** Validate both URL components and the filesystem target before serving a user asset. */
export async function userAssetPath(root: string, urlPath: string, font = false): Promise<string | null> {
    try {
        if (!urlPath.startsWith('/')) return null
        const entry = decodeURIComponent(urlPath.slice(1))
        if (font && (entry.includes('/') || !/\.(ttf|otf|woff2?)$/i.test(entry))) return null
        const file = pluginFilePath(root, entry)
        if (!file) return null
        // Windows aliases (ADS, device names and trailing dots/spaces) must not resolve to other files.
        if (
            entry
                .split('/')
                .some((part) => /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
        )
            return null
        const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(file)])
        if (!isInside(realRoot, realFile) || !(await fs.stat(realFile)).isFile()) return null
        return path.resolve(realFile)
    } catch {
        return null
    }
}
