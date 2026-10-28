import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { PluginManifest } from '../../shared/plugin'
import { LEGACY_PLUGIN_MANIFEST } from '../../shared/legacyBrand'

async function readManifest(directory: string): Promise<string> {
    try {
        return await fs.readFile(path.join(directory, 'iter-plugin.json'), 'utf8')
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return fs.readFile(path.join(directory, LEGACY_PLUGIN_MANIFEST), 'utf8')
    }
}

export interface PluginCandidate {
    manifest: PluginManifest
    directory: string
    entry?: string
    error?: string
}

export function errorMessage(error: unknown): string {
    if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string')
        return error.message
    return String(error)
}

function inside(directory: string, file: string): boolean {
    const relative = path.relative(directory, file)
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function validateManifest(value: unknown): PluginManifest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('manifest 必须是对象')
    const manifest = value as Record<string, unknown>
    if (typeof manifest.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(manifest.id)) {
        throw new Error('manifest.id 必须是 1–64 位字母、数字、下划线或连字符，且以字母或数字开头')
    }
    for (const key of ['name', 'version', 'main'] as const) {
        if (typeof manifest[key] !== 'string' || !manifest[key].trim())
            throw new Error(`manifest.${key} 必须是非空字符串`)
    }
    if (manifest.description !== undefined && typeof manifest.description !== 'string')
        throw new Error('manifest.description 必须是字符串')
    return manifest as unknown as PluginManifest
}

/** Discover before activation so a broken user override cannot activate its bundled copy. */
export async function discover(directory: string): Promise<PluginCandidate[]> {
    let children
    try {
        children = await fs.readdir(directory, { withFileTypes: true })
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        return [
            {
                directory,
                manifest: { id: directory, name: directory, version: '', main: '' },
                error: `无法扫描插件目录: ${errorMessage(error)}`
            }
        ]
    }
    const candidates: PluginCandidate[] = []
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!child.isDirectory() && !child.isSymbolicLink()) continue
        const pluginDir = path.join(directory, child.name)
        const candidate: PluginCandidate = {
            directory: pluginDir,
            manifest: { id: child.name, name: child.name, version: '', main: '' }
        }
        try {
            const raw: unknown = JSON.parse((await readManifest(pluginDir)).replace(/^\uFEFF/, ''))
            // Preserve a valid id even when another field fails validation, keeping user override precedence.
            if (
                raw &&
                typeof raw === 'object' &&
                'id' in raw &&
                typeof raw.id === 'string' &&
                /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(raw.id)
            )
                candidate.manifest.id = raw.id
            candidate.manifest = validateManifest(raw)
            const entry = path.resolve(pluginDir, candidate.manifest.main)
            if (path.isAbsolute(candidate.manifest.main) || !inside(pluginDir, entry) || !/\.(c?js)$/i.test(entry)) {
                throw new Error('manifest.main 必须是插件目录内的 .js 或 .cjs 相对路径')
            }
            const [realDir, realEntry] = await Promise.all([fs.realpath(pluginDir), fs.realpath(entry)])
            if (!inside(realDir, realEntry) || !(await fs.stat(realEntry)).isFile())
                throw new Error('main 必须指向插件目录内的文件')
            candidate.directory = realDir
            candidate.entry = realEntry
        } catch (error) {
            candidate.error = `加载插件失败 (${pluginDir}): ${errorMessage(error)}`
        }
        candidates.push(candidate)
    }
    return candidates
}
