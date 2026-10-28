import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { bundleRoot, type ResourceManifest } from './resourceRuntime'
import type { InteractorRef, JudgeSourceFile } from '../../shared/problem'
import {
    CPP_SOURCE,
    INTERACTOR_SOURCE,
    interactorFilesError,
    MAX_INTERACTOR_FILES
} from '../../shared/interactorSource'

/** A new immutable bundle preserves the previous working interactor if saving fails. */
export async function publishInteractorFiles(
    directory: string,
    files: JudgeSourceFile[],
    args?: string,
    previous?: InteractorRef
): Promise<InteractorRef> {
    const error = interactorFilesError(files)
    if (error) throw new Error(error)
    const root = path.resolve(directory)
    const id = randomUUID()
    const stage = path.join(root, '.resources-' + id)
    const target = path.join(root, 'resources', id)
    await fs.mkdir(stage, { recursive: true })
    try {
        // Imported sources can refer to owned data files through manifest macros.
        // Keep that immutable asset snapshot when the code is edited in this dialog.
        const old =
            previous?.relativeTo !== 'source' && previous?.path
                ? bundleRoot(path.resolve(root, previous.path))
                : undefined
        if (old && path.dirname(old) === path.join(root, 'resources')) {
            const text = await fs
                .readFile(path.join(old, 'bundle.json'), 'utf8')
                .catch((error: NodeJS.ErrnoException) => {
                    if (error.code === 'ENOENT') return undefined
                    throw error
                })
            if (text !== undefined) {
                const copyAssets = async (from: string, to: string): Promise<void> => {
                    for (const entry of await fs.readdir(from, { withFileTypes: true })) {
                        if (entry.isSymbolicLink()) throw new Error('交互器资源不能使用符号链接')
                        const input = path.join(from, entry.name),
                            output = path.join(to, entry.name)
                        if (entry.isDirectory()) {
                            await fs.mkdir(output, { recursive: true })
                            await copyAssets(input, output)
                        } else if (
                            entry.isFile() &&
                            !INTERACTOR_SOURCE.test(entry.name) &&
                            input !== path.join(old, 'bundle.json')
                        ) {
                            await fs.copyFile(input, output)
                        }
                    }
                }
                await copyAssets(old, stage)
                const manifest = JSON.parse(text) as ResourceManifest
                manifest.digest = createHash('sha256')
                    .update(JSON.stringify([manifest.digest, files]))
                    .digest('hex')
                await fs.writeFile(path.join(stage, 'bundle.json'), JSON.stringify(manifest))
            }
        }
        for (const file of files) {
            const output = path.join(stage, ...file.name.split('/'))
            await fs.mkdir(path.dirname(output), { recursive: true })
            await fs.writeFile(output, file.code, 'utf8')
        }
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.rename(stage, target)
    } finally {
        if (path.dirname(stage) !== root) throw new Error('Invalid interactor staging directory')
        await fs.rm(stage, { recursive: true, force: true })
    }
    const primary = files.find((file) => CPP_SOURCE.test(file.name))!
    const relative = (file: JudgeSourceFile) => `resources/${id}/${file.name}`
    return {
        path: relative(primary),
        files: files.filter((file) => file !== primary).map(relative),
        ...(args === undefined ? {} : { args })
    }
}

/** Read pasted files and the companion headers of an existing imported source bundle. */
export async function readInteractorFiles(
    directory: string,
    sourcePath: string,
    ref?: InteractorRef
): Promise<JudgeSourceFile[] | null> {
    if (!ref?.path || !CPP_SOURCE.test(ref.path)) return null
    const anchor = ref.relativeTo === 'source' ? path.dirname(sourcePath) : directory
    const primary = path.resolve(anchor, ref.path)
    const parts = path.relative(directory, primary).split(path.sep)
    const bundled = parts[0] === 'resources' && /^[a-f\d-]{36}$/i.test(parts[1] ?? '')
    let root = bundled ? path.join(directory, 'resources', parts[1]) : path.dirname(primary)
    const paths = [primary, ...(ref.files ?? []).map((file) => path.resolve(anchor, file))]
    const known = new Set(paths.map((file) => file.toLowerCase()))
    const walk = async (folder: string): Promise<void> => {
        for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) throw new Error('交互器文件不能使用符号链接')
            const file = path.join(folder, entry.name)
            if (entry.isDirectory()) await walk(file)
            else if (INTERACTOR_SOURCE.test(entry.name) && !known.has(file.toLowerCase())) {
                paths.push(file)
                known.add(file.toLowerCase())
                if (paths.length > MAX_INTERACTOR_FILES) throw new Error(`交互器文件超过 ${MAX_INTERACTOR_FILES} 个`)
            }
        }
    }
    if (bundled) await walk(root)
    // Old source-relative configurations may keep their companions in another folder.
    while (
        paths.some((file) => {
            const rel = path.relative(root, file)
            return rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)
        })
    ) {
        const parent = path.dirname(root)
        if (parent === root) throw new Error('交互器文件必须位于同一个磁盘')
        root = parent
    }
    let bytes = 0
    const files: JudgeSourceFile[] = []
    for (const file of paths) {
        const info = await fs.lstat(file)
        bytes += info.size
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('交互器源码不是普通文件')
        if (bytes > 16 * 1024 * 1024) throw new Error('交互器源码总大小不能超过 16 MiB')
        files.push({ name: path.relative(root, file).replaceAll('\\', '/'), code: await fs.readFile(file, 'utf8') })
    }
    return files
}
