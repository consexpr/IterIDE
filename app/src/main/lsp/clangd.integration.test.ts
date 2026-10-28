import { spawnSync } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { ClangdBridge } from './clangd'
import { resolveTool } from '../toolchain'
import { patchProblem } from '../problem/store'
import { LspClient } from '../../renderer/lang/rpc'
import type { LspCompletionItem, LspCompletionList } from '../../renderer/lang/protocol'

let executable = '',
    compiler = ''
try {
    executable = resolveTool('clangd', { clangd: process.env.ITER_TEST_CLANGD ?? 'clangd' }).command
    compiler = resolveTool('compiler', { compiler: process.env.ITER_TEST_COMPILER ?? 'g++' }).command
} catch {
    /* Integration tests skip only when the configured/bundled/PATH tools are missing. */
}
const installed =
    spawnSync(executable, ['--version'], { windowsHide: true }).status === 0 &&
    spawnSync(compiler, ['--version'], { windowsHide: true }).status === 0

it.skipIf(!installed)(
    'real clangd: refreshes cached grader headers and adds interactor headers when activated',
    async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), 'iter-clangd-headers-'))
        vi.stubEnv('ITER_STORE', path.join(directory, 'store'))
        const original = path.join(directory, 'original')
        const sourcePath = path.join(directory, 'solution.cpp'),
            uri = pathToFileURL(sourcePath).href
        const code = '#include "perm.h"\nint perm(int n){return n;}\n'
        const listeners = new Set<(message: unknown) => void>(),
            diagnostics: any[] = []
        const bridge = new ClangdBridge((message) => listeners.forEach((listener) => listener(message)))
        bridge.setToolchain(compiler, '-std=c++17')
        const rpc = new LspClient(
            {
                start: () => bridge.start(directory, executable),
                send: (message) => bridge.send(message),
                stop: () => bridge.stop(),
                restart: () => bridge.restart(executable),
                refreshCompileFlags: (file) => bridge.refreshCompileFlags(file),
                onMessage: (listener) => {
                    listeners.add(listener)
                    return () => listeners.delete(listener)
                }
            },
            (method, params) => {
                if (method === 'textDocument/publishDiagnostics') diagnostics.push(params)
            }
        )
        const waitDiagnostics = async (version: number, ready = (_items: any[]) => true): Promise<any[]> => {
            const deadline = Date.now() + 8000
            while (Date.now() < deadline) {
                const found = diagnostics.find(
                    (event) => event.uri === uri && event.version === version && ready(event.diagnostics)
                )
                if (found) return found.diagnostics
                await new Promise((resolve) => setTimeout(resolve, 20))
            }
            throw new Error(
                `No matching clangd diagnostics for version ${version}: ${JSON.stringify(diagnostics.filter((event) => event.version === version))}`
            )
        }
        try {
            await writeFile(sourcePath, code)
            await mkdir(path.join(original, 'channels'), { recursive: true })
            await writeFile(path.join(original, 'perm.h'), 'int perm(int n);\n')
            await writeFile(path.join(original, 'grader.cpp'), '#include "perm.h"\nint main(){return perm(1);}\n')
            await writeFile(path.join(original, 'channels', 'api.h'), 'struct Channel { int value; };\n')
            await writeFile(
                path.join(original, 'interactor.cpp'),
                '#include "channels/api.h"\nint main(){Channel c{0};return c.value;}\n'
            )
            expect(await bridge.start(directory, executable)).toBe(true)
            await rpc.request(
                'initialize',
                { processId: process.pid, rootUri: pathToFileURL(directory).href, capabilities: {} },
                8000
            ).promise
            rpc.notify('initialized', {})
            rpc.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'cpp', version: 1, text: code } })
            expect((await waitDiagnostics(1)).some((item) => /file not found/.test(item.message))).toBe(true)
            await patchProblem(sourcePath, {
                mode: 'grader',
                grader: { sources: [path.join(original, 'grader.cpp')] },
                interactor: { path: path.join(original, 'interactor.cpp') }
            })
            // In grader mode the inactive interactor must not supply include paths.
            await rm(path.join(original, 'grader.cpp'))
            await rm(path.join(original, 'perm.h'))
            await bridge.refreshCompileFlags(sourcePath)
            rpc.notify('textDocument/didChange', {
                textDocument: { uri, version: 2 },
                contentChanges: [{ text: code }]
            })
            expect(
                (await waitDiagnostics(2, (items) => items.every((item) => item.severity !== 1))).filter(
                    (item) => item.severity === 1
                )
            ).toEqual([])
            // Activation captures the interactor before the original directory disappears.
            await patchProblem(sourcePath, { mode: 'interactive' })
            await rm(original, { recursive: true })
            await bridge.refreshCompileFlags(sourcePath)
            rpc.notify('textDocument/didChange', {
                textDocument: { uri, version: 3 },
                contentChanges: [
                    {
                        text: '#include "perm.h"\n#include "api.h"\nint perm(int n){Channel c{n};return c.value;}\n'
                    }
                ]
            })
            expect(
                (await waitDiagnostics(3, (items) => items.every((item) => item.severity !== 1))).filter(
                    (item) => item.severity === 1
                )
            ).toEqual([])
        } finally {
            rpc.dispose()
            await bridge.stop()
            await rm(directory, { recursive: true, force: true, maxRetries: 5 })
            vi.unstubAllEnvs()
        }
    },
    25000
)

it.skipIf(!installed)(
    'real clangd: MinGW/system headers, vector members, syntax diagnostics and flags',
    async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), 'iter-clangd-'))
        vi.stubEnv('ITER_STORE', path.join(directory, 'store'))
        const sourcePath = path.join(directory, 'main.cpp')
        const uri = pathToFileURL(sourcePath).href
        const listeners = new Set<(message: unknown) => void>()
        const diagnostics: any[] = []
        const bridge = new ClangdBridge((message) => {
            for (const listener of listeners) listener(message)
        })
        bridge.setToolchain(compiler, '-std=c++17 -Wall')
        const rpc = new LspClient(
            {
                start: () => bridge.start(directory, executable),
                send: (message) => bridge.send(message),
                onMessage: (listener) => {
                    listeners.add(listener)
                    return () => listeners.delete(listener)
                },
                stop: () => bridge.stop(),
                restart: () => bridge.restart(executable),
                refreshCompileFlags: (source: string) => bridge.refreshCompileFlags(source)
            },
            (method, params) => {
                if (method === 'textDocument/publishDiagnostics') diagnostics.push(params)
            }
        )
        async function waitDiagnostics(version: number, predicate = (_diagnostics: any[]) => true): Promise<any[]> {
            const deadline = Date.now() + 20000
            while (Date.now() < deadline) {
                const found = diagnostics.find(
                    (event) => event.version === version && event.uri === uri && predicate(event.diagnostics)
                )
                if (found) return found.diagnostics
                await new Promise((resolve) => setTimeout(resolve, 25))
            }
            throw new Error(
                `No matching diagnostics for version ${version}: ${JSON.stringify(diagnostics.filter((event) => event.version === version))}`
            )
        }
        try {
            const text = '#include <bits/stdc++.h>\nusing namespace std;\nint main() { vector<int> v; v.pu }\n'
            await writeFile(sourcePath, text)
            expect(await bridge.start(directory, executable)).toBe(true)
            const initialized = await rpc.request<any>('initialize', {
                processId: process.pid,
                rootUri: pathToFileURL(directory).href,
                capabilities: { textDocument: { completion: { completionItem: { snippetSupport: true } } } }
            }).promise
            expect(initialized?.capabilities).toBeDefined()
            rpc.notify('initialized', {})
            rpc.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'cpp', version: 1, text } })
            const first = await waitDiagnostics(1)
            expect(
                first.some((diagnostic) =>
                    /file not found|not found|unknown type name 'vector'/.test(diagnostic.message)
                )
            ).toBe(false)
            const began = performance.now()
            const completion = await rpc.request<LspCompletionItem[] | LspCompletionList>('textDocument/completion', {
                textDocument: { uri },
                position: { line: 2, character: text.split('\n')[2].indexOf('v.pu') + 4 }
            }).promise
            console.info(`[cpp latency] real clangd vector member=${(performance.now() - began).toFixed(2)}ms`)
            const items = Array.isArray(completion) ? completion : (completion?.items ?? [])
            expect(items.some((item) => /push_back/.test(item.label))).toBe(true)
            const invalid = '#include <bits/stdc++.h>\nint main() { int x = ; }\n'
            rpc.notify('textDocument/didChange', {
                textDocument: { uri, version: 2 },
                contentChanges: [{ text: invalid }]
            })
            expect((await waitDiagnostics(2)).some((diagnostic) => diagnostic.severity === 1)).toBe(true)
            // The bridge owns compile flags: changing them must actually change clangd's parse.
            rpc.notify('workspace/didChangeConfiguration', { settings: { iter: { flags: '-std=c++20 -Wall' } } })
            rpc.notify('textDocument/didChange', {
                textDocument: { uri, version: 3 },
                contentChanges: [
                    { text: '#include <bits/stdc++.h>\nstatic_assert(__cplusplus >= 202002L);\nint main() {}\n' }
                ]
            })
            const valid = await waitDiagnostics(3, (items) => items.every((diagnostic) => diagnostic.severity !== 1))
            expect(valid.filter((diagnostic) => diagnostic.severity === 1)).toEqual([])
            rpc.notify('textDocument/didClose', { textDocument: { uri } })
        } finally {
            rpc.dispose()
            await bridge.stop()
            await rm(directory, { recursive: true, force: true })
            vi.unstubAllEnvs()
        }
    },
    60000
)

it('a missing executable returns false without throwing', async () => {
    const bridge = new ClangdBridge(() => {})
    try {
        expect(await bridge.start(os.tmpdir(), path.join(os.tmpdir(), 'iter-missing-clangd-executable'))).toBe(false)
    } finally {
        await bridge.stop()
    }
})

it.skipIf(!installed)(
    'reuses concurrent starts and caps automatic crash recovery at three restarts',
    async () => {
        const states: string[] = []
        const bridge = new ClangdBridge((message) => {
            const value = message as { method?: string; params?: { state: string } }
            if (value.method === '$/iter/status') states.push(value.params!.state)
        })
        const internals = bridge as unknown as { child?: ChildProcessWithoutNullStreams; starting?: Promise<boolean> }
        async function waitFor(predicate: () => boolean): Promise<void> {
            const deadline = Date.now() + 8000
            while (!predicate()) {
                if (Date.now() >= deadline) throw new Error(`Crash recovery timed out: ${states.join(', ')}`)
                await new Promise((resolve) => setTimeout(resolve, 20))
            }
        }
        try {
            const first = bridge.start(os.tmpdir(), executable)
            const pending = internals.starting
            const second = bridge.start(os.tmpdir(), executable)
            expect(internals.starting).toBe(pending)
            expect(await Promise.all([first, second])).toEqual([true, true])
            for (let crash = 0; crash < 4; crash++) {
                const length = states.length
                expect(internals.child?.kill()).toBe(true)
                await waitFor(() => states.slice(length).includes(crash < 3 ? 'restarted' : 'fallback'))
            }
            expect(states.filter((state) => state === 'restarted')).toHaveLength(3)
            expect(states.at(-1)).toBe('fallback')
            expect(internals.child).toBeUndefined()
        } finally {
            await bridge.stop()
        }
    },
    30000
)
