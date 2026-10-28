import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultSettings } from '../../shared/settings'
import { DEFAULT_CLANG_FORMAT_STYLE, type FormatRange } from '../../shared/format'
import { ClangdBridge } from '../lsp/clangd'
import { resolveTool, toolchainEnv } from '../toolchain'
import { LspClient } from '../../renderer/lang/rpc'
import type { LspTextEdit } from '../../renderer/lang/protocol'
import { rangeArguments, runFormat } from './index'
import { effectiveFormatStyle } from './style'

const settings = defaultSettings()
settings.toolchain.clangFormat = process.env.ITER_TEST_CLANG_FORMAT ?? 'clang-format'
settings.toolchain.clangd = process.env.ITER_TEST_CLANGD ?? 'clangd'
settings.toolchain.compiler = process.env.ITER_TEST_COMPILER ?? 'g++'
function installed(name: 'clangFormat' | 'clangd' | 'compiler'): boolean {
    try {
        return (
            spawnSync(resolveTool(name, settings.toolchain).command, ['--version'], {
                env: toolchainEnv(),
                windowsHide: true,
                timeout: 5000
            }).status === 0
        )
    } catch {
        return false
    }
}
const hasFormatter = installed('clangFormat'),
    hasClangd = installed('clangd') && installed('compiler')
const messy = '#include <vector>\nint main(){std::vector<int>v={1,2};for(int x:v){if(x){v.push_back(x);}}return 0;}\n'

describe.skipIf(!hasFormatter)('real clang-format', () => {
    let directory: string, source: string
    beforeEach(async () => {
        directory = await mkdtemp(path.join(os.tmpdir(), 'iter-format-test-'))
        source = path.join(directory, 'unsaved source.cpp')
        settings.editor = defaultSettings().editor
    })
    afterEach(async () => {
        await rm(directory, { recursive: true, force: true })
    })
    async function formatted(code: string, range?: FormatRange): Promise<string> {
        const result = await runFormat(source, code, settings, range)
        if ('error' in result) throw new Error(result.error)
        return result.text
    }

    it('formats an unsaved messy snippet, produces four-space indents and is stable', async () => {
        const text = await formatted(messy)
        expect(text).not.toBe(messy)
        expect(text).toContain('\n    std::vector<int> v = {1, 2};')
        expect(await formatted(text)).toBe(text)
    })

    it('formats a range after Unicode/CRLF without changing a separate declaration', async () => {
        const code = '// 中文 😀\r\nint  untouched( ){return  7;}\r\n\r\nint  target( ){int  x=1;return x+  2;}\r\n'
        const range = { startLineNumber: 4, startColumn: 1, endLineNumber: 4, endColumn: 38 }
        range.endColumn = code.split('\n')[3].replace(/\r$/, '').length + 1
        const text = await formatted(code, range)
        expect(text).toContain('int  untouched( ){return  7;}')
        expect(text).toContain('int target()')
        expect(await formatted(text)).toBe(await formatted(await formatted(text)))
        expect(rangeArguments(code, range)[0]).toBe(
            `--offset=${Buffer.byteLength(code.slice(0, code.indexOf('int  target')), 'utf8')}`
        )
    })

    it('preserves legacy project and inline styles while editor indentation wins', async () => {
        settings.editor.clangFormatStyle = 'file'
        expect(await formatted(messy)).toBe(
            ((await runFormat(source, messy, defaultSettings())) as { text: string }).text
        )
        await writeFile(
            path.join(directory, '.clang-format'),
            'BasedOnStyle: LLVM\nIndentWidth: 6\nBreakBeforeBraces: Allman\n'
        )
        settings.editor.tabSize = 2
        expect(await formatted(messy)).toContain('int main()\n{\n  std::vector<int>')
        settings.editor.clangFormatStyle = '{BasedOnStyle: Google, IndentWidth: 6, BreakBeforeBraces: Allman}'
        expect(await formatted(messy)).toContain('int main()\n{\n  std::vector<int>')
    })

    it('uses the selected width and spaces/tabs for normal, continuation and constructor indentation', async () => {
        settings.editor.clangFormatStyle = '{BasedOnStyle: LLVM, IndentWidth: 6, TabWidth: 8, UseTab: Never}'
        for (const tabSize of [1, 2, 8])
            for (const insertSpaces of [true, false]) {
                Object.assign(settings.editor, { tabSize, insertSpaces })
                // LLVM emits one space rather than a tab when both widths are one column.
                const indent = insertSpaces || tabSize === 1 ? ' '.repeat(tabSize) : '\t'
                const text = await formatted(messy)
                expect(text).toContain(`\n${indent}std::vector<int>`)
                const config = await effectiveFormatStyle(source, settings)
                for (const key of [
                    'IndentWidth',
                    'TabWidth',
                    'ContinuationIndentWidth',
                    'ConstructorInitializerIndentWidth'
                ])
                    expect(config).toContain(`\n${key}: ${tabSize}\n`)
                expect(config).toContain(`\nUseTab: ${insertSpaces ? 'Never' : 'Always'}\n`)
                expect(await formatted(text)).toBe(text)
            }
    })

    it('reports invalid style, missing executable and invalid ranges clearly', async () => {
        settings.editor.clangFormatStyle = '{NotAStyleKey: 1}'
        expect(await runFormat(source, messy, settings)).toHaveProperty(
            'error',
            expect.stringContaining('clang-format failed')
        )
        expect(
            await runFormat(source, messy, {
                ...settings,
                toolchain: { ...settings.toolchain, clangFormat: path.join(directory, 'missing') }
            })
        ).toHaveProperty('error', expect.stringContaining('Configured clangFormat'))
        expect(() =>
            rangeArguments('int x;', { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 })
        ).toThrow('outside')
    })

    it.skipIf(!hasClangd)(
        'matches clangd for inline overrides, file styles, missing config, named styles and ranges',
        async () => {
            const uri = pathToFileURL(source).href
            const listeners = new Set<(message: unknown) => void>()
            const bridge = new ClangdBridge(
                (message) => {
                    for (const listener of listeners) listener(message)
                },
                () => settings
            )
            bridge.setToolchain(settings.toolchain.compiler, settings.toolchain.flags)
            const rpc = new LspClient(
                {
                    start: () => bridge.start(directory, settings.toolchain.clangd),
                    stop: () => bridge.stop(),
                    restart: () => bridge.restart(settings.toolchain.clangd),
                    refreshCompileFlags: (source: string) => bridge.refreshCompileFlags(source),
                    send: (message) => bridge.send(message),
                    onMessage: (listener) => {
                        listeners.add(listener)
                        return () => listeners.delete(listener)
                    }
                },
                () => {}
            )
            const offset = (code: string, position: { line: number; character: number }): number =>
                code
                    .split('\n')
                    .slice(0, position.line)
                    .reduce((sum, line) => sum + line.length + 1, 0) + position.character
            async function clangdFormatted(code: string, range?: FormatRange): Promise<string> {
                const params = {
                    // Stale client options must not override the current main-process setting.
                    textDocument: { uri },
                    iterSource: code,
                    options: { tabSize: 7, insertSpaces: !settings.editor.insertSpaces },
                    ...(range
                        ? {
                              range: {
                                  start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
                                  end: { line: range.endLineNumber - 1, character: range.endColumn - 1 }
                              }
                          }
                        : {})
                }
                const edits = await rpc.request<LspTextEdit[]>(
                    range ? 'textDocument/rangeFormatting' : 'textDocument/formatting',
                    params
                ).promise
                expect(edits).toBeDefined()
                let text = code
                for (const edit of (edits ?? []).sort(
                    (a, b) => offset(code, b.range.start) - offset(code, a.range.start)
                )) {
                    text =
                        text.slice(0, offset(code, edit.range.start)) +
                        edit.newText +
                        text.slice(offset(code, edit.range.end))
                }
                return text
            }
            try {
                expect(await bridge.start(directory, settings.toolchain.clangd)).toBe(true)
                expect(
                    await rpc.request('initialize', {
                        processId: process.pid,
                        rootUri: pathToFileURL(directory).href,
                        capabilities: {}
                    }).promise
                ).toBeDefined()
                rpc.notify('initialized', {})
                rpc.notify('textDocument/didOpen', {
                    textDocument: { uri, languageId: 'cpp', version: 1, text: messy }
                })
                await writeFile(path.join(directory, '.clang-format'), 'BasedOnStyle: LLVM\nIndentWidth: 2\n')
                settings.editor.tabSize = 2
                for (const style of [
                    DEFAULT_CLANG_FORMAT_STYLE,
                    '{BasedOnStyle: LLVM, IndentWidth: 6}',
                    'Google',
                    'file'
                ]) {
                    settings.editor.clangFormatStyle = style
                    expect(await clangdFormatted(messy)).toBe(await formatted(messy))
                }
                settings.editor.clangFormatStyle = DEFAULT_CLANG_FORMAT_STYLE
                for (const tabSize of [1, 2, 8])
                    for (const insertSpaces of [true, false]) {
                        Object.assign(settings.editor, { tabSize, insertSpaces })
                        expect(await clangdFormatted(messy)).toBe(await formatted(messy))
                    }
                settings.editor.insertSpaces = true
                const headers =
                    '#include "aaa.h"\n#include "unsaved source.h"\n#include "zzz.h"\nint main(){return 0;}\n'
                expect(await clangdFormatted(headers)).toBe(await formatted(headers))
                await rm(path.join(directory, '.clang-format'))
                settings.editor.clangFormatStyle = 'file'
                expect(await clangdFormatted(messy)).toBe(await formatted(messy))
                const code = '// 中文 😀\nint  untouched( ){return  7;}\n\nint  target( ){return 1+ 2;}\n'
                const range = {
                    startLineNumber: 4,
                    startColumn: 1,
                    endLineNumber: 4,
                    endColumn: code.split('\n')[3].length + 1
                }
                expect(await clangdFormatted(code, range)).toBe(await formatted(code, range))
            } finally {
                rpc.dispose()
                await bridge.stop()
            }
        },
        60000
    )
})
