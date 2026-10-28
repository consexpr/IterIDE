import { promises as fs } from 'node:fs'
import path from 'node:path'
import { splitArgs } from '../toolchain/args'

function pathArguments(text: string) {
    const args = splitArgs(text)
    const refs: { index: number; prefix: string; original: string; directory: boolean; option?: string }[] = []
    for (let index = 0; index < args.length; index++) {
        const arg = args[index]
        const option = ['-isystem', '-iquote', '-include', '-imacros', '-I', '-L'].find(
            (flag) => arg === flag || (arg.startsWith(flag) && arg.length > flag.length)
        )
        if (option) {
            const attached = arg !== option
            const value = attached ? arg.slice(option.length) : args[++index]
            if (!value) throw new Error('编译参数缺少路径：' + option)
            refs.push({
                index,
                prefix: attached ? option : '',
                original: value,
                directory: !['-include', '-imacros'].includes(option),
                option
            })
        } else if (/\.(?:a|lib|o|obj|so(?:\.\d+)*)$/i.test(arg) && !arg.startsWith('-')) {
            refs.push({ index, prefix: '', original: arg, directory: false })
        }
    }
    return { args, refs }
}

export function mapResourceFlagPaths(text: string, convert: (file: string, directory: boolean) => string): string {
    const { args, refs } = pathArguments(text)
    for (const ref of refs) args[ref.index] = ref.prefix + convert(ref.original, ref.directory).replaceAll('\\', '/')
    return args.map((arg) => (/[\s"']/.test(arg) ? '"' + arg.replaceAll('"', '\\"') + '"' : arg)).join(' ')
}

/** Resolve project-scoped header/library flags without invoking a shell. */
export async function resourceFlags(source: string, text = '') {
    const base = path.dirname(path.resolve(source))
    const includeDirs: string[] = [],
        entries: string[] = []
    const directories: string[] = []
    for (const ref of pathArguments(text).refs) {
        const original = path.resolve(base, ref.original)
        if (ref.directory) directories.push(original)
        if (ref.option === '-L') {
            const libraries = await fs.readdir(original, { withFileTypes: true })
            entries.push(
                ...libraries
                    .filter((item) => item.isFile() && /\.(?:a|lib|dll|o|obj|so(?:\.\d+)*)$/i.test(item.name))
                    .map((item) => path.join(original, item.name))
            )
        } else if (ref.directory) includeDirs.push(original)
        else entries.push(original)
    }
    return {
        includeDirs,
        directories,
        entries,
        rewrite(file: (original: string) => string): string {
            return mapResourceFlagPaths(text, (original, directory) =>
                directory
                    ? path.dirname(file(path.join(path.resolve(base, original), '_anchor_')))
                    : file(path.resolve(base, original))
            )
        }
    }
}
