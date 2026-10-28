import path from 'node:path'

/** Relative flags have the same meaning in compilation, diagnostics and clangd,
 * even when the editor has documents from several source directories open. */
export function sourceCompileContext(sourcePath: string, args: readonly string[]) {
    const source = path.resolve(sourcePath)
    return { sourcePath: source, cwd: path.dirname(source), args: [...args] }
}
