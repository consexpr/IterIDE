import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { builtinModules } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { build } from 'vite'
import { loadProblem, problemDir, readTests, writeTest } from './store'

const execute = promisify(execFile)
let temporary: string, source: string, root: string
beforeEach(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-import-crash-'))
    vi.stubEnv('ITER_STORE', path.join(temporary, 'store'))
    source = path.join(temporary, 'source.cpp')
    await fs.writeFile(source, 'int main() {}')
    await writeTest(source, { name: 'old', input: 'old input', answer: 'old answer' })
    root = problemDir(source)
})
afterEach(async () => {
    vi.unstubAllEnvs()
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5 })
})

// Run production storage in a separate Node process. Exit directly at disk boundaries,
// bypassing every catch/finally, so recovery is exercised against actual crash leftovers.
const child = String.raw`
const fs = require('node:fs'), path = require('node:path')
const store = require(process.argv[2]), source = process.argv[3], root = process.argv[4], boundary = process.argv[5]
const rename = fs.promises.rename.bind(fs.promises), link = fs.promises.link.bind(fs.promises)
let markers = 0
fs.promises.rename = async (from, to) => {
  await rename(from, to)
  if (String(to) === path.join(root, 'problem.json') && boundary === 'config') process.exit(73)
  if (path.basename(String(to)) === 'journal.json') {
    markers++
    if (markers === 2 && boundary === 'marker') process.exit(73)
  }
}
fs.promises.link = async (from, to) => {
  await link(from, to)
  if (path.dirname(String(to)) === path.join(root, 'tests') && boundary === 'files') process.exit(73)
}
store.importProblemBatch(source, { replace: true, tests: [{ name: 'new',
  input: target => fs.promises.writeFile(target, 'new input'), answer: target => fs.promises.writeFile(target, 'new answer')
}] }).then(() => process.exit(0), error => { console.error(error.message); process.exit(1) })
`

describe('real process interruption during import', () => {
    it.each(['files', 'config', 'marker'])(
        'recovers after exiting at the %s boundary',
        async (boundary) => {
            const script = path.join(temporary, 'crash.cjs')
            await fs.writeFile(script, child)
            const app = path.resolve(import.meta.dirname, '../../..')
            const compiled = path.join(temporary, 'store.cjs')
            await build({
                configFile: false,
                root: app,
                logLevel: 'silent',
                plugins: [
                    {
                        name: 'isolated-storage-electron',
                        enforce: 'pre',
                        resolveId: (id) => (id === 'electron' ? '\0electron-storage-test' : null),
                        load: (id) =>
                            id === '\0electron-storage-test'
                                ? 'export const app = { getPath() { throw new Error("Electron user data is unavailable in this storage-only child") } }'
                                : null
                    }
                ],
                build: {
                    outDir: temporary,
                    emptyOutDir: false,
                    minify: false,
                    lib: {
                        entry: path.join(import.meta.dirname, 'store.ts'),
                        formats: ['cjs'],
                        fileName: () => 'store.cjs'
                    },
                    rolldownOptions: {
                        platform: 'node',
                        external: (id) => id.startsWith('node:') || builtinModules.includes(id)
                    }
                }
            })
            await execute(process.execPath, [script, compiled, source, root, boundary], {
                cwd: app,
                env: { ...process.env },
                timeout: 15_000,
                windowsHide: true
            }).then(
                () => {
                    throw new Error('Child did not reach the requested interruption boundary')
                },
                (error) => {
                    expect(error.code, error.stderr).toBe(73)
                }
            )
            expect((await readTests(source, 100)).map((test) => [test.input, test.answer])).toEqual([
                boundary === 'files' ? ['old input', 'old answer'] : ['new input', 'new answer']
            ])
            expect((await loadProblem(source)).tests).toHaveLength(1)
            expect((await fs.readdir(root)).some((name) => name.startsWith('.import-'))).toBe(false)
        },
        20_000
    )
})
