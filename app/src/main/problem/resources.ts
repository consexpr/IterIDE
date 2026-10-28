import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { atomicCopy, atomicWrite } from './atomic'
import { codeResource, resourceDependencies } from './resourceDependencies'
import { resourceStrings, rewriteRuntimeStrings, type ResourceManifest } from './resourceRuntime'

export interface ResourceSource {
    virtual?: { root: string; files: string[] }
    exists(file: string): Promise<boolean>
    text(file: string): Promise<string>
    copy(file: string, target: string): Promise<void>
    siblings(file: string): Promise<string[]>
    size?(file: string): Promise<number>
}
export const diskResources: ResourceSource = {
    size: async (file) => (await fs.stat(file)).size,
    exists: (file) =>
        fs.stat(file).then(
            (info) => info.isFile(),
            (error) => {
                if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false
                throw error
            }
        ),
    text: async (file) => {
        if ((await fs.stat(file)).size > 16 * 1024 * 1024) throw new Error('题目代码依赖过大')
        return fs.readFile(file, 'utf8')
    },
    copy: atomicCopy,
    siblings: async (file) =>
        (await fs.readdir(path.dirname(file), { withFileTypes: true }))
            .filter((entry) => entry.isFile())
            .map((entry) => path.join(path.dirname(file), entry.name))
}
const key = (file: string): string =>
    process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)
const hash = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16)

/** Publish an immutable, content-addressed dependency bundle before configuration references it. */
export async function captureResources(
    directory: string,
    entries: string[],
    includeDirs: string[] = [],
    source: ResourceSource = diskResources,
    overrides = new Map<string, string>(),
    flags = ''
): Promise<{
    file(original: string): string
    includeDirs: string[]
    headers(original: string): Record<string, string>
    runtime(original: string): Record<string, string>
}> {
    entries = entries.map((file) => path.resolve(file))
    const search = [
        ...new Set([...entries.map((file) => path.dirname(file)), ...includeDirs.map((file) => path.resolve(file))])
    ]
    const dependencies = await resourceDependencies(entries, search, source, overrides, flags)
    const files = new Map<
        string,
        { original: string; text?: string; includes: Map<string, string>; runtime: Map<string, string> }
    >()
    const allowed = (file: string): boolean =>
        search.some((root) => {
            const rel = path.relative(root, file)
            return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
        })
    const safeAsset = (file: string): boolean => {
        const relative = search
            .map((root) => path.relative(root, file))
            .filter((name) => name !== '..' && !name.startsWith('..' + path.sep) && !path.isAbsolute(name))
            .sort((a, b) => a.length - b.length)[0]
        return (
            relative !== undefined &&
            !relative
                .split(/[\\/]/)
                .some((part) => part.startsWith('.') || /^(?:id_rsa|id_ed25519|credentials)$/i.test(part)) &&
            !/\.(?:key|pem|pfx|p12)$/i.test(file)
        )
    }
    const binaries = new Set<string>()
    const visit = async (file: string): Promise<void> => {
        file = path.resolve(file)
        if (files.has(key(file))) return
        if (files.size >= 10000) throw new Error('题目依赖超过 10000 个文件')
        const item = { original: file, includes: new Map<string, string>(), runtime: new Map<string, string>() } as {
            original: string
            text?: string
            includes: Map<string, string>
            runtime: Map<string, string>
        }
        files.set(key(file), item)
        if (codeResource.test(file)) {
            const text = overrides.get(file) ?? (await source.text(file))
            if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error('题目代码依赖过大')
            item.text = text
            const names = [...text.matchAll(/^\s*#\s*(?:include\s*|define\s+\w+\s+)["<]([^">\r\n]+)[">]/gm)].map(
                (match) => match[1]
            )
            for (const name of new Set(names)) {
                const candidates = path.isAbsolute(name)
                    ? [name]
                    : [path.resolve(path.dirname(file), name), ...search.map((dir) => path.resolve(dir, name))]
                const found = candidates.find((candidate) =>
                    dependencies.some((dependency) => key(dependency) === key(candidate))
                )
                if (found) item.includes.set(name, found)
            }
            for (const name of resourceStrings(text)) {
                const asset = path.resolve(path.dirname(file), name)
                if (!allowed(asset) || !safeAsset(asset) || !(await source.exists(asset)) || codeResource.test(asset))
                    continue
                item.runtime.set(name, asset)
                await visit(asset)
            }
        } else if (/\.(?:exe|dll)$/i.test(file)) {
            const parent = key(path.dirname(file))
            if (!binaries.has(parent)) {
                binaries.add(parent)
                for (const sibling of await source.siblings(file)) if (/\.dll$/i.test(sibling)) await visit(sibling)
            }
        }
    }
    for (const file of [...entries, ...dependencies]) await visit(file)
    const relativeFile = (file: string): string => path.join(hash(key(path.dirname(file))), path.basename(file))
    const stage = path.join(directory, '.resources-' + randomUUID())
    await fs.mkdir(stage, { recursive: true })
    const aliases = new Map<string, string>(),
        assets: Record<string, string> = {}
    let id: string
    const dirs = [...new Set([...files.values()].map((item) => path.dirname(relativeFile(item.original))))]
    // Flag paths can name an empty include/library directory; preserve its anchor too.
    const anchors = includeDirs.map((dir) => hash(key(dir)))
    try {
        for (const anchor of anchors) await fs.mkdir(path.join(stage, anchor), { recursive: true })
        let assetBytes = 0
        for (const item of files.values()) {
            if (item.text !== undefined) continue
            assetBytes += (await source.size?.(item.original)) ?? 0
            if (assetBytes > 512 * 1024 * 1024) throw new Error('题目依赖超过 512 MiB')
            const output = path.join(stage, relativeFile(item.original))
            await fs.mkdir(path.dirname(output), { recursive: true })
            await source.copy(item.original, output)
        }
        const runtimeIds = new Map<string, string>()
        for (const item of files.values())
            for (const original of item.runtime.values()) {
                if (runtimeIds.has(original)) continue
                const digest = createHash('sha256').update(key(original))
                for await (const chunk of createReadStream(path.join(stage, relativeFile(original))))
                    digest.update(chunk)
                runtimeIds.set(original, 'ITER_RESOURCE_' + digest.digest('hex').slice(0, 16))
            }
        for (const item of files.values()) {
            const output = path.join(stage, relativeFile(item.original))
            await fs.mkdir(path.dirname(output), { recursive: true })
            if (item.text === undefined) continue
            else {
                let text = item.text
                const headers: Record<string, string> = {},
                    macros: Record<string, string> = {}
                for (const [name, original] of item.includes) {
                    headers[name] = path
                        .relative(path.dirname(relativeFile(item.original)), relativeFile(original))
                        .replaceAll('\\', '/')
                    const alias = '__iter_header_' + hash(key(original)) + '.h'
                    macros[name] = entries.includes(item.original) ? headers[name] : alias
                    if (macros[name] === alias) aliases.set(alias, relativeFile(original))
                }
                text = rewriteResourceIncludes(text, headers, macros)
                const runtime: Record<string, string> = {}
                for (const [name, original] of item.runtime) {
                    const identifier = runtimeIds.get(original)!
                    assets[identifier] = relativeFile(original).replaceAll('\\', '/')
                    runtime[name] = identifier
                }
                text = rewriteRuntimeStrings(text, runtime)
                if (/\.(?:h|hh|hpp|hxx|inc|inl|tpp)$/i.test(item.original)) {
                    const original = item.original.replaceAll('\\', '/').replaceAll('"', '\\"')
                    text = '#line 1 "' + original + '"\n' + text
                }
                await atomicWrite(output, text)
            }
        }
        if (aliases.size) {
            dirs.push('aliases')
            await fs.mkdir(path.join(stage, 'aliases'))
            for (const [name, target] of aliases)
                await atomicWrite(
                    path.join(stage, 'aliases', name),
                    '#include "../' + target.replaceAll('\\', '/') + '"\n'
                )
        }
        const digest = createHash('sha256'),
            listing: string[] = []
        const list = async (dir: string): Promise<void> => {
            for (const item of await fs.readdir(dir, { withFileTypes: true })) {
                const file = path.join(dir, item.name)
                if (item.isDirectory()) await list(file)
                else listing.push(file)
            }
        }
        await list(stage)
        let bytes = 0
        for (const file of listing.sort()) {
            digest.update(path.relative(stage, file).replaceAll('\\', '/') + '\0')
            for await (const chunk of createReadStream(file)) {
                bytes += chunk.length
                if (bytes > 512 * 1024 * 1024) throw new Error('题目依赖超过 512 MiB')
                digest.update(chunk)
            }
        }
        digest.update(JSON.stringify([dirs, assets, [...new Set(anchors)].sort()]))
        const fullDigest = digest.digest('hex')
        id = [
            fullDigest.slice(0, 8),
            fullDigest.slice(8, 12),
            fullDigest.slice(12, 16),
            fullDigest.slice(16, 20),
            fullDigest.slice(20, 32)
        ].join('-')
        const manifest: ResourceManifest = { version: 1, digest: fullDigest, includeDirs: dirs, assets }
        await atomicWrite(path.join(stage, 'bundle.json'), JSON.stringify(manifest))
        const target = path.join(directory, 'resources', id)
        await fs.mkdir(path.dirname(target), { recursive: true })
        for (let attempt = 0; ; attempt++) {
            try {
                await fs.rename(stage, target)
                break
            } catch (error) {
                const existing = await fs.readFile(path.join(target, 'bundle.json'), 'utf8').catch(() => undefined)
                if (existing && JSON.parse(existing).digest === fullDigest) {
                    await fs.rm(stage, { recursive: true, force: true })
                    break
                }
                if (
                    process.platform !== 'win32' ||
                    attempt >= 10 ||
                    !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')
                )
                    throw error
                await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)))
            }
        }
        const now = new Date()
        await fs.utimes(target, now, now)
    } catch (error) {
        await fs.rm(stage, { recursive: true, force: true })
        throw error
    }
    const relative = path.join('resources', id)
    return {
        file: (file) => path.join(relative, relativeFile(file)),
        headers: (file) =>
            Object.fromEntries(
                [...(files.get(key(file))?.includes ?? [])].map(([name, original]) => [
                    name,
                    path.join(relative, relativeFile(original)).replaceAll('\\', '/')
                ])
            ),
        runtime: (file) =>
            Object.fromEntries(
                [...(files.get(key(file))?.runtime ?? [])].map(([name, original]) => [
                    name,
                    path.join(relative, relativeFile(original)).replaceAll('\\', '/')
                ])
            ),
        includeDirs: dirs.map((dir) => path.join(relative, dir))
    }
}

export function rewriteResourceIncludes(text: string, headers: Record<string, string>, macros = headers): string {
    return text.replace(
        /^([\t ]*#\s*(?:include\s*|define\s+\w+\s+))(?:"([^"\r\n]+)"|<([^>\r\n]+)>)/gm,
        (whole, prefix: string, quoted: string | undefined, angle: string | undefined) => {
            const name = quoted ?? angle ?? ''
            const mapping = /#\s*define/.test(prefix) ? macros : headers
            const mapped = Object.hasOwn(mapping, name) ? mapping[name] : undefined
            return mapped ? prefix + '"' + mapped.replaceAll('\\', '/') + '"' : whole
        }
    )
}
