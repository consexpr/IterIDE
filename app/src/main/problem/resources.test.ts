import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resourceFlags } from './resourceFlags'
import { captureResources, rewriteResourceIncludes } from './resources'
import {
    attachCode,
    readAttached,
    attachFile,
    loadProblem,
    patchProblem,
    problemDir,
    readTests,
    importTestFiles
} from './store'
import { applyImport, previewImport } from '../importer'
import { writeZip } from '../importer/fixtures/zip'

let directory: string
let original: string
let source: string
beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-contained-'))
    original = path.join(directory, 'original')
    await fs.mkdir(original)
    source = path.join(original, 'A.cpp')
    await fs.writeFile(source, 'int main() {}')
    vi.stubEnv('ITER_STORE', path.join(directory, 'store'))
})
afterEach(async () => {
    vi.unstubAllEnvs()
    const target = path.resolve(directory)
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('iter-contained-'))
        throw new Error('Unexpected cleanup directory')
    await fs.rm(target, { recursive: true, force: true, maxRetries: 5 })
})
it('owns nested, parent-relative, macro and absolute header dependencies', async () => {
    await fs.mkdir(path.join(original, 'include'))
    const header = path.join(original, 'include', 'value.h')
    await fs.writeFile(header, '#pragma once\n#define VALUE 7\n')
    await fs.writeFile(path.join(original, 'include', 'api.h'), '#include "../shared.h"\n')
    await fs.writeFile(path.join(original, 'shared.h'), '#pragma once\n#define OTHER 1\n')
    const tool = path.join(original, 'checker.cpp')
    await fs.writeFile(
        tool,
        '#define HEADER "include/api.h"\n#include HEADER\n#include "' +
            header.replaceAll('\\', '/') +
            '"\nint main(){return VALUE;}'
    )
    const relative = await attachFile(source, tool, 'checker')
    await patchProblem(source, { checker: { kind: 'custom', path: relative }, mode: 'spj' })
    await fs.rm(original, { recursive: true })
    const config = await loadProblem(source)
    const checker = path.join(problemDir(source), config.checker.path!)
    const text = await fs.readFile(checker, 'utf8')
    expect(text).not.toContain(original.replaceAll('\\', '/'))
    const headers = [...text.matchAll(/(?:include|define HEADER)\s+"([^"]+)"/g)].map((match) =>
        path.resolve(path.dirname(checker), match[1])
    )
    expect(headers).toHaveLength(2)
    expect(await fs.readFile(headers[1], 'utf8')).toContain('#define VALUE 7')
    const nested = await fs.readFile(headers[0], 'utf8')
    expect(
        await fs.readFile(path.resolve(path.dirname(headers[0]), nested.match(/#include "([^"]+)"/)![1]), 'utf8')
    ).toContain('OTHER 1')
})
it('owns executable side-by-side DLLs', async () => {
    const executable = path.join(original, 'checker.exe')
    await fs.writeFile(executable, 'synthetic-executable')
    await fs.writeFile(path.join(original, 'helper.dll'), 'synthetic-library')
    const relative = await attachFile(source, executable, 'checker')
    const cached = path.join(problemDir(source), relative)
    await fs.rm(original, { recursive: true })
    expect(await fs.readFile(path.join(path.dirname(cached), 'helper.dll'), 'utf8')).toBe('synthetic-library')
})
it('extracts referenced ZIP dependencies before removing the archive', async () => {
    const zip = path.join(original, 'data.zip')
    await writeZip(zip, [
        { name: '1.in', content: '1' },
        { name: '1.ans', content: '2' },
        { name: 'checker.cpp', content: '#include "lib/helper.h"\nint main(){return VALUE;}' },
        { name: 'lib/helper.h', content: '#define VALUE 0' }
    ])
    const preview = await previewImport(zip)
    await applyImport({ sourcePath: source, preview, replace: true, attachExtras: true })
    await fs.rm(original, { recursive: true })
    const config = await loadProblem(source)
    const tool = path.join(problemDir(source), config.checker.path!)
    const text = await fs.readFile(tool, 'utf8')
    const header = text.match(/#include "([^"]+)"/)![1]
    expect(await fs.readFile(path.resolve(path.dirname(tool), header), 'utf8')).toContain('#define VALUE 0')
    expect((await readTests(source, 100))[0]).toMatchObject({ input: '1', answer: '2' })
})
it('preserves the committed configuration when a replacement dependency cannot be copied', async () => {
    await loadProblem(source)
    const config = await fs.readFile(path.join(problemDir(source), 'problem.json'))
    const tool = path.join(original, 'bad.cpp')
    await fs.writeFile(tool, '#include "missing.h"')
    await expect(patchProblem(source, { checker: { kind: 'custom', path: tool } })).rejects.toThrow('missing.h')
    expect(await fs.readFile(path.join(problemDir(source), 'problem.json'))).toEqual(config)
    expect((await fs.readdir(problemDir(source))).some((name) => name.startsWith('.resources-'))).toBe(false)
})
it('keeps cached tests after both original paths and source disappear', async () => {
    const input = path.join(original, '1.in'),
        answer = path.join(original, '1.ans')
    await fs.writeFile(input, '123\n')
    await fs.writeFile(answer, '456\n')
    await importTestFiles(source, { name: 'case', input, answer }, true)
    await fs.rm(original, { recursive: true })
    expect((await readTests(source, 100))[0]).toMatchObject({ input: '123\n', answer: '456\n' })
})
it('rewrites directives without rewriting ordinary string literals', () => {
    expect(rewriteResourceIncludes('#include "api.h"\nconst char* x="api.h";', { 'api.h': 'cached.h' })).toBe(
        '#include "cached.h"\nconst char* x="api.h";'
    )
})
it('cleans unpublished bundles when copying a binary fails', async () => {
    const dir = problemDir(source)
    await expect(captureResources(dir, [path.join(original, 'missing.exe')])).rejects.toThrow()
    expect((await fs.readdir(dir)).some((name) => name.startsWith('.resources-'))).toBe(false)
})

it('owns explicit static libraries and library search directories from per-problem flags', async () => {
    const libraryDir = path.join(original, 'dep libs')
    await fs.mkdir(libraryDir)
    await fs.writeFile(path.join(libraryDir, 'libhelper.a'), 'synthetic-library')
    await loadProblem(source)
    await patchProblem(source, { extraFlags: '-L "dep libs" "dep libs/libhelper.a" -lhelper' })
    const cfg = await loadProblem(source)
    const flags = await resourceFlags(source, cfg.extraFlags)
    expect(flags.entries.some((file) => file.includes('resources'))).toBe(true)
    await fs.rm(original, { recursive: true })
    for (const entry of flags.entries) expect(await fs.readFile(entry, 'utf8')).toBe('synthetic-library')
    expect((await loadProblem(source)).extraFlags).toBe(cfg.extraFlags)
})

it('reads an owned n-check snapshot without permitting paths outside the resource bundle', async () => {
    const code = 'int main(){return 0;}'
    const file = await attachCode(source, code)
    await patchProblem(source, { checker: { kind: 'custom', path: file } })
    const cfg = await loadProblem(source)
    expect(await readAttached(source, cfg.checker.path!)).toBe(code)
    expect(await readAttached(source, 'resources/../../outside.cpp')).toBeNull()
})

async function compileFixture(file: string, text: string) {
    const { configureToolchain } = await import('../toolchain')
    configureToolchain(path.resolve('resources/toolchain'))
    const { compileSource } = await import('../judge/compile')
    return compileSource(
        file,
        text,
        {
            compiler: 'g++',
            flags: '-std=c++17 -O0',
            debugFlags: '-g',
            gdb: 'gdb',
            clangd: 'clangd',
            clangFormat: 'clang-format',
            parallel: 1,
            outputLimitBytes: 100000,
            displayLimitChars: 10000
        },
        false
    )
}
it('regression: ignores inactive includes during capture', async () => {
    const file = path.join(original, 'checker.cpp')
    const code = '#if 0\n#include "not_installed.h"\n#endif\nint main(){return 0;}'
    await fs.writeFile(file, code)
    const result = await compileFixture(file, code)
    expect(result.ok, result.output).toBe(true)
    const relative = await attachFile(source, file, 'checker')
    await fs.rm(original, { recursive: true })
    const cached = path.join(problemDir(source), relative)
    const captured = await compileFixture(cached, await fs.readFile(cached, 'utf8'))
    expect(captured.ok, captured.output).toBe(true)
})
it('regression: captures cross-header macros', async () => {
    await fs.writeFile(path.join(original, 'config.h'), '#define HEADER "helper.h"\n')
    await fs.writeFile(path.join(original, 'helper.h'), '#define VALUE 7\n')
    const file = path.join(original, 'checker.cpp')
    const code = '#include "config.h"\n#include HEADER\nint main(){return VALUE==7?0:1;}'
    await fs.writeFile(file, code)
    const result = await compileFixture(file, code)
    expect(result.ok, result.output).toBe(true)
    const relative = await attachFile(source, file, 'checker')
    await fs.rm(original, { recursive: true })
    const cached = path.join(problemDir(source), relative)
    const captured = await compileFixture(cached, await fs.readFile(cached, 'utf8'))
    expect(captured.ok, captured.output).toBe(true)
})
it('regression: relocates compiler library paths with the store', async () => {
    const libDir = path.join(original, 'libs')
    await fs.mkdir(libDir)
    await fs.writeFile(path.join(libDir, 'libaudit.a'), 'synthetic library')
    await loadProblem(source)
    await patchProblem(source, { extraFlags: '-L libs -laudit' })
    const first = problemDir(source),
        id = path.basename(first)
    const secondRoot = path.join(directory, 'second-store'),
        second = path.join(secondRoot, 'problems', id)
    await fs.cp(first, second, { recursive: true })
    const meta = JSON.parse(await fs.readFile(path.join(second, 'meta.json'), 'utf8'))
    meta.sourcePath = '/old-machine/source.cpp'
    await fs.writeFile(path.join(second, 'meta.json'), JSON.stringify(meta))
    vi.stubEnv('ITER_STORE', secondRoot)
    const restored = path.join(original, 'restored.cpp')
    await fs.writeFile(restored, 'int main(){}')
    const { bindIdentity } = await import('./identity')
    bindIdentity(restored, id)
    await fs.rm(path.join(directory, 'store'), { recursive: true })
    expect((await fs.readdir(path.join(second, 'resources'))).length).toBeGreaterThan(0)
    const cfg = await loadProblem(restored)
    const flags = await resourceFlags(restored, cfg.extraFlags)
    expect(flags.entries).toHaveLength(1)
    expect(await fs.readFile(flags.entries[0], 'utf8')).toBe('synthetic library')
    expect(cfg.extraFlags).not.toContain(first.replaceAll('\\', '/'))
})
it('regression: owns an absolute runtime asset after deleting the originals', async () => {
    const asset = path.join(original, 'weights.txt')
    await fs.writeFile(asset, '7')
    const file = path.join(original, 'checker.cpp')
    const code =
        '#include <fstream>\n#include <iostream>\nint main(){int x=0;std::ifstream("' +
        asset.replaceAll('\\', '/') +
        '")>>x;std::cout<<x;}'
    await fs.writeFile(file, code)
    const relative = await attachFile(source, file, 'checker'),
        cached = path.join(problemDir(source), relative)
    const result = await compileFixture(cached, await fs.readFile(cached, 'utf8'))
    expect(result.ok, result.output).toBe(true)
    const { execFile } = await import('node:child_process'),
        { promisify } = await import('node:util')
    const { toolchainEnv } = await import('../toolchain')
    expect((await promisify(execFile)(result.exe!, [], { windowsHide: true, env: toolchainEnv() })).stdout).toBe('7')
    await fs.rm(original, { recursive: true })
    expect((await promisify(execFile)(result.exe!, [], { windowsHide: true, env: toolchainEnv() })).stdout).toBe('7')
})
it('regression: deduplicates repeated identical attachments', async () => {
    const file = path.join(original, 'checker.cpp')
    await fs.writeFile(file, 'int main(){}')
    await loadProblem(source)
    const root = path.join(problemDir(source), 'resources')
    const before = (await fs.readdir(root)).length
    for (let i = 0; i < 3; i++) await attachFile(source, file, 'checker')
    expect((await fs.readdir(root)).length - before).toBe(1)
})
it('regression: compiles a cc checker', async () => {
    const file = path.join(original, 'checker.cc')
    await fs.writeFile(file, 'int main(){return 0;}')
    const relative = await attachFile(source, file, 'checker'),
        cached = path.join(problemDir(source), relative)
    const { prepareTool } = await import('../judge/checkers')
    const exe = await prepareTool(problemDir(source), relative, {
        compiler: 'g++',
        flags: '-std=c++17',
        debugFlags: '-g',
        gdb: 'gdb',
        clangd: 'clangd',
        clangFormat: 'clang-format',
        parallel: 1,
        outputLimitBytes: 100000,
        displayLimitChars: 10000
    })
    expect(exe).not.toBe(cached)
    expect((await fs.stat(exe)).isFile()).toBe(true)
})

it('keeps runtime resources portable after moving the whole bundle and deleting both old directories', async () => {
    const tool = path.join(original, 'portable.cpp')
    await fs.writeFile(path.join(original, 'weights.txt'), '9')
    await fs.mkdir(path.join(original, 'config'))
    await fs.writeFile(path.join(original, 'config', 'paths.h'), '#define WEIGHTS "weights.txt"\n')
    await fs.writeFile(
        tool,
        '#include <fstream>\n#include <iostream>\n#include "config/paths.h"\nint main(){int n=0;std::ifstream(WEIGHTS)>>n;std::cout<<n;}'
    )
    // Runtime literals in a header are resolved relative to that header's project include roots.
    await fs.writeFile(path.join(original, 'config', 'weights.txt'), '9')
    const relative = await attachFile(source, tool, 'checker')
    const first = problemDir(source),
        moved = path.join(directory, 'moved')
    await fs.cp(first, moved, { recursive: true })
    await fs.rm(first, { recursive: true })
    await fs.rm(original, { recursive: true })
    const cached = path.join(moved, relative)
    const result = await compileFixture(cached, await fs.readFile(cached, 'utf8'))
    expect(result.ok, result.output).toBe(true)
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { toolchainEnv } = await import('../toolchain')
    expect((await promisify(execFile)(result.exe!, [], { windowsHide: true, env: toolchainEnv() })).stdout).toBe('9')
})
it('captures conditional dependencies selected by the problem compiler flags', async () => {
    await fs.writeFile(path.join(original, 'selected.h'), '#define VALUE 7\n')
    const code = '#if USE_LOCAL\n#include "selected.h"\n#endif\nint main() {return VALUE;}'
    const bundle = await captureResources(
        problemDir(source),
        [source],
        [],
        undefined,
        new Map([[source, code]]),
        '-DUSE_LOCAL=1'
    )
    expect(bundle.headers(source)).toHaveProperty('selected.h')
})
it('preserves empty include and library flag directories', async () => {
    await fs.mkdir(path.join(original, 'empty'))
    await loadProblem(source)
    await patchProblem(source, { extraFlags: '-I empty -L empty' })
    const cfg = await loadProblem(source)
    expect((await resourceFlags(source, cfg.extraFlags)).entries).toEqual([])
})
