import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { FormatRange, FormatResult } from '../../shared/format'
import type { AppSettings } from '../../shared/settings'
import { resolveTool, toolchainEnv } from '../toolchain'
import { effectiveFormatStyle } from './style'

/** clang-format offsets count UTF-8 bytes; Monaco's columns count UTF-16 units. */
export function rangeArguments(code: string, range: FormatRange): string[] {
    const lines = code.split('\n')
    const offset = (line: number, column: number): number => {
        const content = lines[line - 1]?.replace(/\r$/, '')
        if (
            !Number.isInteger(line) ||
            !Number.isInteger(column) ||
            line < 1 ||
            column < 1 ||
            content === undefined ||
            column > content.length + 1
        )
            throw new Error('Formatting range is outside the document')
        return lines.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0) + column - 1
    }
    const start = offset(range.startLineNumber, range.startColumn),
        end = offset(range.endLineNumber, range.endColumn)
    if (end < start) throw new Error('Formatting range ends before it starts')
    return [
        `--offset=${Buffer.byteLength(code.slice(0, start), 'utf8')}`,
        `--length=${Buffer.byteLength(code.slice(start, end), 'utf8')}`
    ]
}

export async function runFormat(
    sourcePath: string,
    code: string,
    settings: AppSettings,
    range?: FormatRange
): Promise<FormatResult> {
    try {
        if (!path.isAbsolute(sourcePath)) throw new Error('Formatting requires an absolute source path')
        const command = resolveTool('clangFormat', settings.toolchain).command
        const style = await effectiveFormatStyle(sourcePath, settings, command)
        const directory = await mkdtemp(path.join(os.tmpdir(), 'iter-format-'))
        try {
            const configuration = path.join(directory, '.clang-format')
            await writeFile(configuration, style, 'utf8')
            const args = [
                `--assume-filename=${sourcePath}`,
                `--style=file:${configuration}`,
                '--fallback-style=LLVM',
                ...(range ? rangeArguments(code, range) : [])
            ]
            const text = await new Promise<string>((resolve, reject) => {
                const child = execFile(
                    command,
                    args,
                    {
                        env: toolchainEnv(),
                        windowsHide: true,
                        timeout: 10000,
                        maxBuffer: 32 * 1024 * 1024,
                        encoding: 'utf8'
                    },
                    (error, stdout, stderr) => {
                        if (error) reject(new Error(`clang-format failed: ${stderr.trim() || error.message}`))
                        else resolve(stdout)
                    }
                )
                child.stdin?.on('error', () => {}) // close/error is reported by execFile
                child.stdin?.end(code, 'utf8')
            })
            return { text }
        } finally {
            await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
        }
    } catch (error) {
        return { error: (error as Error).message }
    }
}
