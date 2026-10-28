import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { ClangdBridge } from './clangd'
import { resolveTool } from '../toolchain'
import { LspClient } from '../../renderer/lang/rpc'
import { CLIENT_CAPABILITY, ITER_LEGEND, remapSemanticTokens, type SemanticLegend } from '../../renderer/lang/semantic'

let executable = '',
    compiler = ''
try {
    executable = resolveTool('clangd', { clangd: process.env.ITER_TEST_CLANGD ?? 'clangd' }).command
    compiler = resolveTool('compiler', { compiler: process.env.ITER_TEST_COMPILER ?? 'g++' }).command
} catch {
    /* skipped when the configured/bundled/PATH tools are missing */
}
const installed =
    spawnSync(executable, ['--version'], { windowsHide: true }).status === 0 &&
    spawnSync(compiler, ['--version'], { windowsHide: true }).status === 0

const SOURCE = [
    '#define ls (n)',
    '#define rs (m),x',
    '#define rsxk u+1',
    'int g = 1;',
    'const int LIM = 5;',
    'struct P { int f; };',
    'int solve(int n, int m) {',
    '  int u = 2, x = 3;',
    '  P p; p.f = ls + rs + rsxk + g + LIM;',
    '  return u;',
    '}',
    ''
].join('\n')

/** Names of the ITER classes at every `word` occurrence on a line. */
function classesAt(
    text: string,
    tokens: Uint32Array
): (line: number, word: string, nth?: number) => string | undefined {
    const lines = text.split('\n')
    const found = new Map<string, string>()
    let line = 0,
        character = 0
    for (let i = 0; i < tokens.length; i += 5) {
        line += tokens[i]
        character = tokens[i] === 0 ? character + tokens[i + 1] : tokens[i + 1]
        found.set(`${line}:${character}`, ITER_LEGEND.tokenTypes[tokens[i + 3]])
    }
    return (at, word, nth = 0) => {
        const matches = [...lines[at].matchAll(new RegExp(String.raw`\b${word}\b`, 'g'))]
        return found.get(`${at}:${matches[nth]?.index}`)
    }
}

it.skipIf(!installed)(
    'real clangd: macros share one class, scopes differ, and the server answers pings and restarts',
    async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), 'iter-semantic-'))
        vi.stubEnv('ITER_STORE', path.join(directory, 'store'))
        const sourcePath = path.join(directory, 'main.cpp')
        const uri = pathToFileURL(sourcePath).href
        const listeners = new Set<(message: unknown) => void>()
        const statuses: string[] = []
        const bridge = new ClangdBridge((message) => {
            for (const listener of listeners) listener(message)
        })
        bridge.setToolchain(compiler, '-std=c++17')
        const rpc = new LspClient(
            {
                start: () => bridge.start(directory, executable),
                send: (message) => bridge.send(message),
                stop: () => bridge.stop(),
                restart: () => bridge.restart(executable),
                refreshCompileFlags: (source: string) => bridge.refreshCompileFlags(source),
                onMessage: (listener) => {
                    listeners.add(listener)
                    return () => listeners.delete(listener)
                }
            },
            (method, params) => {
                if (method === '$/iter/status') statuses.push(params.state)
            }
        )
        try {
            await writeFile(sourcePath, SOURCE)
            expect(await bridge.start(directory, executable)).toBe(true)
            const initialized = await rpc.request<any>(
                'initialize',
                {
                    processId: process.pid,
                    rootUri: pathToFileURL(directory).href,
                    capabilities: { textDocument: { semanticTokens: CLIENT_CAPABILITY } }
                },
                20000
            ).promise
            const legend = initialized?.capabilities?.semanticTokensProvider?.legend as SemanticLegend
            expect(legend?.tokenTypes).toContain('macro')
            rpc.notify('initialized', {})
            rpc.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'cpp', version: 1, text: SOURCE } })
            const reply = await rpc.request<{ data: number[] }>(
                'textDocument/semanticTokens/full',
                { textDocument: { uri } },
                20000
            ).promise
            expect(reply?.data?.length).toBeGreaterThan(0)
            const classOf = classesAt(SOURCE, remapSemanticTokens(reply!.data, legend))

            // every use of a macro is the same class, whatever its spelling or what follows it
            expect([classOf(8, 'ls'), classOf(8, 'rs'), classOf(8, 'rsxk')]).toEqual(['macro', 'macro', 'macro'])
            expect(classOf(8, 'g')).toBe('variable.global')
            expect(classOf(8, 'LIM')).toBe('constant')
            expect(classOf(8, 'p')).toBe('variable.local')
            expect(classOf(8, 'f')).toBe('variable.field')
            expect(classOf(9, 'u')).toBe('variable.local')
            expect(classOf(6, 'n')).toBe('variable.param')
            expect(classOf(6, 'solve')).toBe('function')

            // a live server answers an unknown method with an error, which is all the watchdog needs
            expect(await rpc.probe(5000)).toBe(true)

            // a killed server comes back and says so
            statuses.length = 0
            expect(await bridge.restart(executable)).toBe(true)
            const deadline = Date.now() + 20000
            while (!statuses.includes('restarted') && Date.now() < deadline)
                await new Promise((resolve) => setTimeout(resolve, 50))
            expect(statuses).toContain('restarted')
        } finally {
            await bridge.stop()
            rpc.dispose()
            vi.unstubAllEnvs()
            await rm(directory, { recursive: true, force: true, maxRetries: 5 })
        }
    },
    90000
)
