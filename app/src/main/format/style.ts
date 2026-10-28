import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_CLANG_FORMAT_STYLE } from '../../shared/format'
import { indentationSettings, type IndentationSettings } from '../../shared/indentation'
import type { AppSettings } from '../../shared/settings'
import { resolveTool, toolchainEnv } from '../toolchain'

/** LLVM 17 only accepts a *named* --fallback-style, not inline YAML. Resolve the
 * no-file fallback ourselves so both clangd and clang-format use the CP style. */
async function requestedFormatStyle(sourcePath: string, setting: string): Promise<string> {
    const style = setting.trim() || DEFAULT_CLANG_FORMAT_STYLE
    if (style !== 'file') return style
    let directory = path.dirname(path.resolve(sourcePath))
    while (true) {
        for (const name of ['.clang-format', '_clang-format']) {
            try {
                if ((await stat(path.join(directory, name))).isFile()) return 'file'
            } catch (error) {
                if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
            }
        }
        const parent = path.dirname(directory)
        if (parent === directory) return DEFAULT_CLANG_FORMAT_STYLE
        directory = parent
    }
}

/** Only edit top-level scalars from clang-format's canonical output, never user YAML. */
export function synchronizeIndentation(configuration: string, editor: IndentationSettings): string {
    const { tabSize, insertSpaces } = indentationSettings(editor)
    const overrides: Record<string, string> = {
        IndentWidth: String(tabSize),
        TabWidth: String(tabSize),
        UseTab: insertSpaces ? 'Never' : 'Always',
        ContinuationIndentWidth: String(tabSize),
        ConstructorInitializerIndentWidth: String(tabSize)
    }
    const missing = new Set(Object.keys(overrides))
    const lines = configuration.split(/\r?\n/).map((line) => {
        const key = /^([A-Za-z][A-Za-z0-9]*):/.exec(line)?.[1]
        if (!key || !Object.hasOwn(overrides, key)) return line
        missing.delete(key)
        return `${key}: ${overrides[key]}`
    })
    if (missing.size) throw new Error(`clang-format configuration is missing ${[...missing].join(', ')}`)
    return lines.join('\n')
}

/** Resolve legacy named/inline/file styles with clang-format itself, then give
 * both formatting transports exactly the same editor-controlled indentation. */
export async function effectiveFormatStyle(
    sourcePath: string,
    settings: AppSettings,
    command = resolveTool('clangFormat', settings.toolchain).command,
    signal?: AbortSignal
): Promise<string> {
    const style = await requestedFormatStyle(sourcePath, settings.editor.clangFormatStyle)
    const configuration = await new Promise<string>((resolve, reject) => {
        const child = execFile(
            command,
            [`--assume-filename=${sourcePath}`, `--style=${style}`, '--dump-config'],
            {
                env: toolchainEnv(),
                windowsHide: true,
                timeout: 10000,
                maxBuffer: 4 * 1024 * 1024,
                encoding: 'utf8',
                signal
            },
            (error, stdout, stderr) => {
                if (error) reject(new Error(`clang-format failed: ${stderr.trim() || error.message}`))
                else resolve(stdout)
            }
        )
        child.stdin?.on('error', () => {})
        child.stdin?.end()
    })
    return synchronizeIndentation(configuration, settings.editor)
}
