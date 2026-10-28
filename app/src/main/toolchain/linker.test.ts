import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ResolvedTool } from '../../shared/judge'
import { compilerFlags } from './linker'

describe('bundled GCC linker selection', () => {
    let directory: string, tool: ResolvedTool
    beforeEach(() => {
        directory = mkdtempSync(path.join(os.tmpdir(), 'iter-linker-'))
        const bin = path.join(directory, '新装 测试', 'bin')
        mkdirSync(bin, { recursive: true })
        writeFileSync(path.join(bin, 'ld.lld.exe'), '')
        tool = { command: path.join(bin, 'g++.exe'), source: 'bundled' }
    })
    afterEach(() => rmSync(directory, { recursive: true, force: true }))

    it('selects the bundled lld for ordinary Windows builds without changing input flags', () => {
        const flags = Object.freeze([
            '-std=c++17',
            '-O2',
            '-Wall',
            '-DNAME=1',
            '-I',
            'headers',
            '-L',
            'libraries',
            '-lpsapi',
            '-lshell32',
            '-static'
        ])
        expect(compilerFlags(tool, flags, 'win32')).toEqual([...flags, '-fuse-ld=lld'])
        expect(flags).not.toContain('-fuse-ld=lld')
    })

    it('leaves ASCII installations, other platforms and custom compilers unchanged', () => {
        const flags = ['-flto', '-Wl,--start-group', '@options.rsp']
        expect(compilerFlags({ ...tool, command: path.join(directory, 'bin', 'g++.exe') }, flags, 'win32')).toEqual(
            flags
        )
        expect(compilerFlags(tool, flags, 'linux')).toEqual(flags)
        expect(compilerFlags(tool, flags, 'darwin')).toEqual(flags)
        expect(compilerFlags({ ...tool, source: 'configured' }, flags, 'win32')).toEqual(flags)
        expect(compilerFlags({ ...tool, source: 'path' }, flags, 'win32')).toEqual(flags)
        expect(
            compilerFlags({ ...tool, command: path.join(path.dirname(tool.command), 'clang++.exe') }, flags, 'win32')
        ).toEqual(flags)
    })

    it.each([['-fuse-ld=bfd'], ['-fuse-ld=lld'], ['-fuse-ld', 'gold']])(
        'preserves explicit linker selection %j',
        (...selection) => {
            const flags = ['-flto', '@options.rsp', ...selection]
            expect(compilerFlags(tool, flags, 'win32')).toEqual(flags)
        }
    )

    it.each([
        '-flto',
        '-flto=auto',
        '-fwhole-program',
        '-fuse-linker-plugin',
        '@options.rsp',
        '-Wl,--start-group',
        '-Xlinker',
        '-Tscript.ld',
        '--script=script.ld',
        '-specs=custom.specs',
        '--sysroot=other',
        '-isysroot',
        '-Bother',
        '-fplugin=custom.dll',
        '-wrapper',
        'external.o',
        'external.a',
        'custom.def'
    ])('refuses to silently change linker semantics for %s', (flag) => {
        expect(() => compilerFlags(tool, ['-O2', flag], 'win32')).toThrow(/ASCII.*-fuse-ld/)
        expect(() => compilerFlags(tool, ['-O2', flag], 'win32')).toThrow(flag)
    })

    it('does not mistake include/library directory operands for linker configuration', () => {
        const flags = ['-I', '@headers', '-include', 'prelude.h', '-L', 'libraries.a']
        expect(compilerFlags(tool, flags, 'win32')).toEqual([...flags, '-fuse-ld=lld'])
    })

    it('reports a missing or invalid bundled lld instead of selecting a PATH executable', () => {
        const linker = path.join(path.dirname(tool.command), 'ld.lld.exe')
        rmSync(linker)
        expect(() => compilerFlags(tool, [], 'win32')).toThrow(/ld\.lld.*ASCII/)
        mkdirSync(linker)
        expect(() => compilerFlags(tool, [], 'win32')).toThrow(/ld\.lld.*ASCII/)
    })
})
