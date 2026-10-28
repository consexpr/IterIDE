import type { JudgeSourceFile } from './problem'

export const CPP_SOURCE = /\.(?:c|cc|cpp|cxx)$/i
export const INTERACTOR_SOURCE = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|inc|inl|tpp)$/i
export const MAX_INTERACTOR_FILES = 64

/** Shared by the editor and IPC receiver; file names remain portable between machines. */
export function interactorFilesError(value: unknown): string | undefined {
    if (!Array.isArray(value) || !value.length) return '至少添加一个 CPP 文件'
    if (value.length > MAX_INTERACTOR_FILES) return `最多添加 ${MAX_INTERACTOR_FILES} 个文件`
    const names = new Set<string>()
    let bytes = 0
    for (const file of value as JudgeSourceFile[]) {
        if (!file || typeof file.name !== 'string' || typeof file.code !== 'string') return '文件格式无效'
        const parts = file.name.split('/')
        if (
            file.name.length > 240 ||
            !INTERACTOR_SOURCE.test(file.name) ||
            /[\\<>:"|?*\x00-\x1f]/.test(file.name) ||
            parts.some(
                (part) =>
                    !part ||
                    part === '.' ||
                    part === '..' ||
                    /[. ]$/.test(part) ||
                    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
            )
        )
            return '文件名须为 CPP 或头文件，可使用子目录，不能使用绝对路径或 ..'
        const key = file.name.toLowerCase()
        if (names.has(key)) return `文件名重复：${file.name}`
        names.add(key)
        if (!file.code.trim()) return `${file.name} 的内容为空`
        bytes += new TextEncoder().encode(file.code).length
        if (bytes > 16 * 1024 * 1024) return '交互器源码总大小不能超过 16 MiB'
    }
    if (!value.some((file: JudgeSourceFile) => CPP_SOURCE.test(file.name))) return '至少保留一个 CPP 文件'
}
