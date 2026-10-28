import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compileSource } from './compile'
import { execute } from './process'
import { resolveTool } from '../toolchain'
import type { ToolchainSettings } from '../../shared/judge'

const tools = { compiler: 'g++', flags: '-std=c++17', debugFlags: '-g' } as ToolchainSettings
let dir: string
beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-cache-regression-'))
    await fs.mkdir(path.join(dir, 'detail'))
})
afterEach(async () => {
    vi.unstubAllEnvs()
    await fs.rm(dir, { recursive: true, force: true })
})
it('invalidates actual nested dependencies of every translation unit without running the executable', async () => {
    const main = path.join(dir, 'main.cpp'),
        helper = path.join(dir, 'helper.cpp')
    const header = path.join(dir, 'detail', 'value')
    await fs.writeFile(header, '#define VALUE 1\n')
    await fs.writeFile(helper, '#include "detail/value"\nint value(){return VALUE;}\n')
    const source = 'int value(); int main(){return value();}'
    const plan = { sources: [helper], includeDirs: [dir] }
    const first = await compileSource(main, source, tools, false, '', undefined, [], undefined, plan)
    expect(first.ok, first.output).toBe(true)
    expect((await compileSource(main, source, tools, false, '', undefined, [], undefined, plan)).cached).toBe(true)
    await fs.writeFile(header, '#error dependency was changed\n')
    const changed = await compileSource(main, source, tools, false, '', undefined, [], undefined, plan)
    expect(changed.cached).toBe(false)
    expect(changed.ok).toBe(false)
    expect(changed.output).toContain('dependency was changed')
}, 30_000)
it('does not reuse executables after an explicitly linked static library changes', async () => {
    const compiler = resolveTool('compiler', tools).command
    const ar = path.join(path.dirname(compiler), process.platform === 'win32' ? 'ar.exe' : 'ar')
    const unit = path.join(dir, 'library.cpp'),
        object = path.join(dir, 'library.o'),
        library = path.join(dir, 'libvalue.a')
    const buildLibrary = async (value: number): Promise<void> => {
        await fs.writeFile(unit, `int value(){return ${value};}`)
        const compiled = await execute(compiler, ['-c', unit, '-o', object], { timeout: 10_000 })
        expect(compiled.code, compiled.stderr).toBe(0)
        const archived = await execute(ar, ['rcs', library, object], { timeout: 10_000 })
        expect(archived.code, archived.stderr).toBe(0)
    }
    await buildLibrary(1)
    const src = path.join(dir, 'linked.cpp'),
        source = 'int value(); int main(){return value();}'
    const tc = { ...tools, flags: `-std=c++17 -L "${dir}" -lvalue` }
    const first = await compileSource(src, source, tc, false)
    expect(first.ok, first.output).toBe(true)
    await buildLibrary(2)
    const changed = await compileSource(src, source, tc, false)
    expect(changed.ok, changed.output).toBe(true)
    expect(changed.cached).toBe(false)
    expect(changed.exe).not.toBe(first.exe)
    expect(await fs.readFile(changed.exe!)).not.toEqual(await fs.readFile(first.exe!))
}, 30_000)
it('rechecks include resolution when a higher-priority shadow header is added', async () => {
    const early = path.join(dir, 'early'),
        late = path.join(dir, 'late')
    await fs.mkdir(early)
    await fs.mkdir(late)
    await fs.writeFile(path.join(late, 'value.h'), '#define VALUE 1\n')
    const tc = { ...tools, flags: `-std=c++17 -I "${early}" -I "${late}"` }
    const src = path.join(dir, 'main.cpp'),
        source = '#include <value.h>\nint main(){return VALUE;}'
    const first = await compileSource(src, source, tc, false)
    expect(first.ok, first.output).toBe(true)
    await fs.writeFile(path.join(early, 'value.h'), '#error higher priority header\n')
    const changed = await compileSource(src, source, tc, false)
    expect(changed).toMatchObject({ ok: false, cached: false })
    expect(changed.output).toContain('higher priority header')
}, 30_000)
it.skipIf(process.platform !== 'win32')(
    'keeps cache executables launchable under a deeply nested temporary root',
    async () => {
        const temporary = path.join(dir, 'x'.repeat(Math.max(1, 120 - dir.length - 1)))
        await fs.mkdir(temporary)
        vi.stubEnv('TEMP', temporary)
        vi.stubEnv('TMP', temporary)
        const src = path.join(dir, 'main.cpp'),
            source = 'int main(){return 0;}'
        const result = await compileSource(src, source, tools, false)
        expect(result.ok, result.output).toBe(true)
        expect(result.exe!.length).toBeLessThan(260)
        expect(await execute(result.exe!, [], { timeout: 2000 })).toMatchObject({ code: 0, timedOut: false })
        expect((await compileSource(src, source, tools, false)).cached).toBe(true)
        const manifestFile = path.join(path.dirname(result.exe!), 'compile.json')
        const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'))
        expect(manifest.key).toMatch(/^[a-f0-9]{64}$/)
        await fs.writeFile(manifestFile, JSON.stringify({ ...manifest, key: '0'.repeat(64) }))
        expect((await compileSource(src, source, tools, false)).cached).toBe(false)
    },
    30_000
)
