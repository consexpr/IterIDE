import { afterEach, beforeEach, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkSyntax, compileSource } from './compile'
import { configureToolchain } from '../toolchain'
import type { ToolchainSettings } from '../../shared/judge'

let directory: string
beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-syntax-context-'))
    configureToolchain(path.resolve('resources/toolchain'))
})
afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true })
})
it('resolves relative include flags from the source directory in builds and fallback diagnostics', async () => {
    await fs.mkdir(path.join(directory, 'include'))
    await fs.writeFile(path.join(directory, 'include', 'value.h'), '#define VALUE 7\n')
    const source = '#include <value.h>\nint main(){return VALUE;}\n'
    const file = path.join(directory, 'main.cpp')
    const tools = { compiler: 'g++', flags: '-std=c++17 -I include', debugFlags: '-g' } as ToolchainSettings
    const compiled = await compileSource(file, source, tools, false)
    expect(compiled.ok, compiled.output).toBe(true)
    const signal = new AbortController().signal
    expect(await checkSyntax(file, source, tools, signal)).toEqual([])
    expect(await checkSyntax(file, source, tools, signal, ['-std=c++17', '-I', 'include'])).toEqual([])
}, 30_000)
