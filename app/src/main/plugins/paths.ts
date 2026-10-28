import path from 'node:path'

export function isInside(directory: string, file: string): boolean {
    const relative = path.relative(directory, file)
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** Paths use URL separators; reject Windows drive/ADS paths and ambiguous URL syntax too. */
export function pluginFilePath(directory: string, entry: string): string | null {
    if (!entry || /[\\\u0000-\u001f\u007f:?#]/.test(entry)) return null
    const parts = entry.split('/')
    if (parts.some((part) => !part || part === '.' || part === '..')) return null
    const file = path.resolve(directory, ...parts)
    return isInside(directory, file) ? file : null
}
