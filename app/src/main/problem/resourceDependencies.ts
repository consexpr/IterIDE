import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveTool } from '../toolchain'
import { splitArgs } from '../toolchain/args'
import { execute } from '../judge/process'
import { parseDepfile } from '../judge/depfile'
import { resourceFile } from '../judge/resources'
import type { ResourceSource } from './resources'

export const codeResource = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|inc|inl|tpp)$/i
const canonical = (file: string) =>
    process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)

/** Ask the real preprocessor, including its conditionals and cross-header macro state. */
export async function resourceDependencies(
    entries: string[],
    dirs: string[],
    source: ResourceSource,
    overrides: Map<string, string>,
    flags = ''
): Promise<string[]> {
    const units = entries.filter((file) => codeResource.test(file))
    if (!units.length) return []
    const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-deps-'))
    try {
        const virtual = source.virtual
        const local = (file: string): string => {
            if (!virtual) return file
            const rel = path.relative(virtual.root, file)
            if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return file
            return path.join(stage, 'files', rel)
        }
        const originals = new Map<string, string>()
        if (virtual) {
            const files = virtual.files.filter((file) => codeResource.test(file))
            if (files.length > 10000) throw new Error('题目依赖超过 10000 个文件')
            for (const file of files) {
                const target = local(file)
                await fs.mkdir(path.dirname(target), { recursive: true })
                const text = overrides.get(file) ?? (await source.text(file))
                if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error('题目代码依赖过大')
                await fs.writeFile(target, text)
                originals.set(canonical(target), file)
            }
        }
        const bundled = path.dirname(await resourceFile('testlib/testlib.h'))
        const options: string[] = []
        const args = splitArgs(flags)
        for (let i = 0; i < args.length; i++) {
            if (['-D', '-U', '-include', '-imacros'].includes(args[i])) {
                const option = args[i],
                    value = args[++i]
                if (value)
                    options.push(
                        option,
                        option === '-include' || option === '-imacros'
                            ? local(path.resolve(path.dirname(entries[0]), value))
                            : value
                    )
            } else if (/^-(?:include|imacros)./.test(args[i])) {
                const match = /^(-include|-imacros)(.+)$/.exec(args[i])!
                options.push(match[1], local(path.resolve(path.dirname(entries[0]), match[2])))
            } else if (/^-(?:D.|U.|std=|O[0-3sgz]?$|pthread$)/.test(args[i])) options.push(args[i])
        }
        const compiler = resolveTool('compiler', { compiler: 'g++' }).command
        const result = new Set<string>()
        for (const [index, file] of units.entries()) {
            const input = path.join(stage, index + '.cpp'),
                depfile = path.join(stage, index + '.d')
            // An edited/missing source is supplied as a buffer; quote lookup still starts in its original directory.
            await fs.writeFile(input, overrides.get(file) ?? (await source.text(file)))
            const includeDirs = [local(path.dirname(file)), ...dirs.map(local), bundled]
            const run = await execute(
                compiler,
                [
                    '-std=c++17',
                    ...options,
                    ...includeDirs.flatMap((dir) => ['-I', dir]),
                    '-MM',
                    '-MG',
                    '-MF',
                    depfile,
                    '-MT',
                    'resource',
                    input
                ],
                { cwd: stage, timeout: 10000, outputLimit: 2 * 1024 * 1024 }
            )
            if (run.code !== 0 || run.error || run.timedOut || run.outputExceeded)
                throw new Error('题目依赖不存在：预处理失败\n' + (run.error ?? run.stderr))
            for (const dependency of parseDepfile(await fs.readFile(depfile, 'utf8'))) {
                const absolute = path.resolve(stage, dependency)
                if (absolute === input) continue
                let original = originals.get(canonical(absolute)) ?? absolute
                if (canonical(absolute) === canonical(path.join(bundled, 'testlib.h'))) {
                    original = path.join(path.dirname(file), 'testlib.h')
                    overrides.set(original, await fs.readFile(absolute, 'utf8'))
                }
                if (!overrides.has(original) && !(await source.exists(original)))
                    throw new Error('题目依赖不存在：' + dependency + '（' + file + '）')
                result.add(original)
            }
        }
        return [...result]
    } finally {
        await fs.rm(stage, { recursive: true, force: true })
    }
}
