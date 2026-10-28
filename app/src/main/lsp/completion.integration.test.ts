import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { pathToFileURL } from 'node:url'
import { ClangdBridge } from './clangd'
import { resolveTool } from '../toolchain'
import { fakeModel, fixture, token } from '../../renderer/lang/test-support'

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
    'golden typing: real clangd through the visible Monaco completion provider',
    async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), 'iter-completion-'))
        vi.stubEnv('ITER_STORE', path.join(directory, 'store'))
        const source = path.join(directory, 'main.cpp')
        const listeners = new Set<(message: unknown) => void>()
        const diagnostics = new Set<number>()
        const bridge = new ClangdBridge((message) => {
            const m = message as { method?: string; params?: { version: number } }
            if (m.method === 'textDocument/publishDiagnostics') diagnostics.add(m.params!.version)
            for (const listener of listeners) listener(message)
        })
        bridge.setToolchain(compiler, '-std=c++20')
        const f = fixture(true, {
            start: (root) => bridge.start(root, executable),
            stop: () => bridge.stop(),
            send: (message) => bridge.send(message),
            restart: () => bridge.restart(executable),
            refreshCompileFlags: (source: string) => bridge.refreshCompileFlags(source),
            onMessage: (listener) => {
                listeners.add(listener)
                return () => listeners.delete(listener)
            }
        })
        f.settings.completion = {
            snippets: [
                { trigger: 'all', body: '${1:first}.begin(), ${2:last}.end()' },
                { trigger: 'fo', body: 'for (${1:int i = 0}; ${2:condition}; ${3:++i}) {\n\t$0\n}' }
            ]
        }
        const preamble = '#include <bits/stdc++.h>\nusing namespace std;\n'
        const model = fakeModel(preamble)
        const latencies: number[] = []
        let barrierId = -1
        async function waitFor(predicate: () => boolean): Promise<void> {
            const deadline = Date.now() + 20000
            while (!predicate()) {
                if (Date.now() > deadline) throw new Error(`clangd did not become ready (status=${f.service.status()})`)
                await new Promise((resolve) => setTimeout(resolve, 20))
            }
        }
        async function reset(text: string): Promise<void> {
            model.edit(text)
            // clangd can suppress identical diagnostics. documentSymbol waits for the current AST.
            const id = barrierId--
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => {
                    listeners.delete(listener)
                    reject(new Error('AST barrier timed out'))
                }, 20000)
                const listener = (message: unknown): void => {
                    if ((message as { id?: number }).id !== id) return
                    clearTimeout(timer)
                    listeners.delete(listener)
                    resolve()
                }
                listeners.add(listener)
                bridge.send({
                    jsonrpc: '2.0',
                    id,
                    method: 'textDocument/documentSymbol',
                    params: { textDocument: { uri: pathToFileURL(source).href } }
                })
            })
        }
        async function complete(): Promise<{ suggestions: any[]; incomplete?: boolean }> {
            const began = performance.now()
            const result = await f.providers.completion.provideCompletionItems(
                model.model,
                model.position(),
                { triggerKind: 0 },
                token
            )
            latencies.push(performance.now() - began)
            return result
        }
        async function type(
            text: string,
            check?: (result: { suggestions: any[]; incomplete?: boolean }, char: string) => void
        ) {
            let result: { suggestions: any[]; incomplete?: boolean } = { suggestions: [] }
            for (const char of text) {
                const position = model.position(),
                    offset = model.model.getValue().length
                model.edit(model.model.getValue() + char, [
                    {
                        rangeOffset: offset,
                        rangeLength: 0,
                        text: char,
                        range: {
                            startLineNumber: position.lineNumber,
                            endLineNumber: position.lineNumber,
                            startColumn: position.column,
                            endColumn: position.column
                        }
                    }
                ])
                result = await complete()
                check?.(result, char)
            }
            return result.suggestions
        }
        try {
            await writeFile(source, preamble)
            f.service.attach(model.model, source)
            await waitFor(() => f.service.status() === 'clangd' && diagnostics.has(1))
            await reset('')
            let headerCount = 0
            await type('#include<bits/stdc++.h>', (result, char) => {
                expect(result.suggestions.every((item) => item.kind === 20 || item.kind === 23)).toBe(true)
                expect(result.suggestions.some((item) => /begin\(|\bend\(/.test(item.insertText))).toBe(false)
                if (char === '<') headerCount = result.suggestions.length
            })
            expect(headerCount).toBeGreaterThan(0)
            // Quoted includes exercise the string exception and the header edit range too.
            await reset(preamble)
            const quoted = await type('#include "vec')
            expect(quoted.map((item) => item.label)).toContain('vector')
            expect(quoted.every((item) => item.kind === 20 || item.kind === 23)).toBe(true)

            await reset(preamble)
            expect((await type('int main(){ vector<int> vec; long long total = 0; ve'))[0]?.label).toBe('vec')
            await reset(preamble + 'int main(){ vector<int> vec; long long total = 0; ')
            expect((await type('to'))[0]?.label).toBe('total')
            await reset(preamble + 'int main(){ vector<int> vec; ')
            const members = await type('vec.')
            expect(members.length).toBeGreaterThan(0)
            expect(members.some((item) => item.label.startsWith('_M_'))).toBe(false)
            expect((await type('pu'))[0]).toMatchObject({
                label: 'push_back',
                insertText: 'push_back($0)',
                insertTextRules: 4
            })
            await reset(preamble + 'int main(){ ')
            expect((await type('std::so')).find((item) => item.label === 'sort')).toMatchObject({
                insertText: 'sort($0)',
                insertTextRules: 4
            })
            await reset(preamble + 'int main(){ ')
            expect((await type('std::gc')).some((item) => item.label === 'gcd')).toBe(true)
            await reset(preamble + 'int main(){ ')
            await type('// comment ve', (result) => expect(result.suggestions).toEqual([]))
            await reset(preamble + 'int main(){ ')
            expect((await type('fo')).some((item) => item.label === 'for' || item.kind === 27)).toBe(true)
            await reset(preamble + 'struct Object { void foo(); }; int main(){ Object x; ')
            const qualified = await type('x.fo')
            expect(qualified.some((item) => item.label === 'foo')).toBe(true)
            expect(qualified.some((item) => item.label === 'for' || item.kind === 27)).toBe(false)
            const declarations =
                [
                    'void ping(); void c_void(void); void query(int value);',
                    'void iter_optional(int value = 0); void callback(void (*fn)());',
                    'int (*factory())(); std::function<void()> callable_factory();',
                    'void overloaded(); void overloaded(int value);'
                ].join('\n') + '\n'
            for (const [locals, typed, name, insertText] of [
                ['queue<int> q; ', 'q.em', 'empty', 'empty()$0'],
                ['queue<int> q; ', 'q.po', 'pop', 'pop()$0'],
                ['queue<int> q; ', 'q.si', 'size', 'size()$0'],
                ['vector<int> v; ', 'v.cl', 'clear', 'clear()$0'],
                ['vector<int> v; ', 'v.pu', 'push_back', 'push_back($0)'],
                ['vector<int> v; ', 'v.re', 'resize', 'resize($0)'],
                ['', 'pin', 'ping', 'ping()$0'],
                ['', 'c_vo', 'c_void', 'c_void()$0'],
                ['', 'qu', 'query', 'query($0)'],
                ['', 'iter_opti', 'iter_optional', 'iter_optional($0)'],
                ['', 'callb', 'callback', 'callback($0)'],
                ['', 'fact', 'factory', 'factory()$0'],
                ['', 'callable_f', 'callable_factory', 'callable_factory()$0'],
                ['', 'overlo', 'overloaded', 'overloaded($0)']
            ]) {
                await reset(preamble + declarations + 'int main(){ ' + locals)
                const suggestions = await type(typed)
                expect(
                    suggestions.find((item) => item.label === name),
                    typed
                ).toMatchObject({ insertText, insertTextRules: 4 })
            }
            latencies.sort((a, b) => a - b)
            console.info(
                `[cpp typing latency] ${latencies.length} keys p50=${latencies[Math.floor(latencies.length * 0.5)].toFixed(2)}ms p95=${latencies[Math.floor(latencies.length * 0.95)].toFixed(2)}ms max=${latencies.at(-1)!.toFixed(2)}ms`
            )
        } finally {
            f.service.dispose()
            await bridge.stop()
            await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
            vi.unstubAllEnvs()
        }
    },
    60000
)
