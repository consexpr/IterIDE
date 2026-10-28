import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { compileArgsFor } from '../judge/flags'
import { ClangdBridge } from './clangd'

vi.mock('../judge/flags', () => ({ compileArgsFor: vi.fn() }))
const compile = vi.mocked(compileArgsFor)
const flush = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
}

function fixture() {
    const messages: any[] = [],
        errors: any[] = []
    const bridge = new ClangdBridge((message) => errors.push(message))
    // Exercise the bridge's real sequencing/configuration without spawning a server.
    Object.assign(bridge, { child: { stdin: { writable: true } }, root: path.resolve('.') })
    vi.spyOn(bridge as any, 'write').mockImplementation((...args: unknown[]) => {
        messages.push(args[0])
    })
    const file = path.resolve('flags.cpp'),
        uri = pathToFileURL(file).href
    const open = {
        method: 'textDocument/didOpen',
        params: { textDocument: { uri, languageId: 'cpp', version: 1, text: '' } }
    }
    const change = {
        method: 'textDocument/didChange',
        params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'int value;' }] }
    }
    return { bridge, messages, errors, file, uri, open, change }
}

beforeEach(() => compile.mockReset())
describe('per-source clangd compile arguments', () => {
    it('resolves each document relative to its own source directory across projects', async () => {
        const f = fixture()
        const other = path.resolve('other-project', 'src', 'main.cpp')
        compile.mockResolvedValue(['-std=c++20', '-I', '../include'])
        await f.bridge.refreshCompileFlags(f.file)
        await f.bridge.refreshCompileFlags(other)
        const commands = f.messages.map((message) => message.params.settings.compilationDatabaseChanges)
        expect(commands[0][f.file].workingDirectory).toBe(path.dirname(f.file))
        expect(commands[1][other].workingDirectory).toBe(path.dirname(other))
        expect(commands[1][other].compilationCommand).toContain('../include')
    })
    it('uses judge compileArgsFor before open and preserves queued document/request order', async () => {
        const f = fixture()
        let finish!: (args: string[]) => void
        compile.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve
                })
        )
        f.bridge.send(f.open)
        f.bridge.send(f.change)
        const request = { id: 1, method: 'textDocument/completion', params: { textDocument: { uri: f.uri } } }
        f.bridge.send(request)
        expect(f.messages).toEqual([])
        expect(compile).toHaveBeenCalledWith(f.file, expect.any(String))
        finish(['-std=c++20', '-I', 'grader headers', '-DGRADER'])
        await flush()
        expect(f.messages[0].params.settings.compilationDatabaseChanges[f.file].compilationCommand).toEqual([
            'g++',
            '-x',
            'c++',
            '-std=c++20',
            '-I',
            'grader headers',
            '-DGRADER',
            f.file
        ])
        expect(f.messages.slice(1)).toEqual([f.open, f.change, request])
    })
    it('recomputes mode arguments, avoids identical commands and ignores superseded work', async () => {
        const f = fixture()
        compile.mockResolvedValueOnce(['-std=c++17'])
        f.bridge.send(f.open)
        await flush()
        f.messages.length = 0
        compile.mockResolvedValueOnce(['-std=c++17'])
        await f.bridge.refreshCompileFlags(f.file)
        expect(f.messages).toEqual([])
        let old!: (args: string[]) => void, latest!: (args: string[]) => void
        compile.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    old = resolve
                })
        )
        compile.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    latest = resolve
                })
        )
        const first = f.bridge.refreshCompileFlags(f.file)
        f.bridge.setFlags('-std=c++23')
        f.bridge.send(f.change)
        old(['-std=c++20', '-DOLD'])
        await first
        expect(f.messages).toEqual([])
        latest(['-std=c++23', '-DNEW'])
        await flush()
        expect(compile).toHaveBeenLastCalledWith(f.file, '-std=c++23')
        expect(f.messages[0].params.settings.compilationDatabaseChanges[f.file].compilationCommand).toContain('-DNEW')
        expect(f.messages[1]).toEqual(f.change)
    })
    it('reports configuration failures and releases pending document traffic', async () => {
        const f = fixture()
        compile.mockRejectedValueOnce(new Error('mode configuration missing'))
        f.bridge.send(f.open)
        f.bridge.send(f.change)
        await flush()
        expect(f.messages).toEqual([f.open, f.change])
        expect(f.errors[0].params.message).toContain('mode configuration missing')
    })

    it('removes cancelled requests that are still waiting for compile arguments', async () => {
        const f = fixture()
        let finish!: (args: string[]) => void
        compile.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve
                })
        )
        f.bridge.send(f.open)
        f.bridge.send({ id: 7, method: 'textDocument/completion', params: { textDocument: { uri: f.uri } } })
        f.bridge.send({ method: '$/cancelRequest', params: { id: 7 } })
        finish(['-std=c++20'])
        await flush()
        expect(f.messages.map((message) => message.method)).toEqual([
            'workspace/didChangeConfiguration',
            'textDocument/didOpen'
        ])
    })
})
