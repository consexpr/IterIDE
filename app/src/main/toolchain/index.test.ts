import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultSettings } from '../../shared/settings'
import { ToolchainResolver } from './index'

describe('toolchain resolution', () => {
    let directory: string, bundle: string, system: string
    const settings = defaultSettings().toolchain
    function executable(file: string): string {
        mkdirSync(path.dirname(file), { recursive: true })
        writeFileSync(file, '')
        chmodSync(file, 0o755)
        return file
    }
    beforeEach(() => {
        directory = mkdtempSync(path.join(os.tmpdir(), 'iter-resolver-'))
        bundle = path.join(directory, 'bundle with spaces')
        system = path.join(directory, 'system')
    })
    afterEach(() => rmSync(directory, { recursive: true, force: true }))

    it('uses an existing absolute override before the bundle, and reports invalid overrides', () => {
        executable(path.join(bundle, 'bin', 'g++.exe'))
        const override = executable(path.join(system, 'custom compiler.exe'))
        const resolver = new ToolchainResolver(bundle, { Path: system }, 'win32')
        expect(resolver.resolveTool('compiler', { compiler: override })).toEqual({
            command: override,
            source: 'configured'
        })
        expect(() => resolver.resolveTool('compiler', { compiler: path.join(system, 'missing.exe') })).toThrow(
            'Configured compiler'
        )
        expect(() => resolver.resolveTool('compiler', { compiler: system })).toThrow('not executable')
        expect(() => resolver.resolveTool('compiler', { compiler: './g++' })).toThrow('absolute executable path')
    })

    it('prefers all bundled tools for bare names, even without PATH', () => {
        const resolver = new ToolchainResolver(bundle, {}, 'win32')
        for (const [name, file] of [
            ['compiler', 'g++'],
            ['gdb', 'gdb'],
            ['clangd', 'clangd'],
            ['clangFormat', 'clang-format']
        ] as const) {
            const command = executable(path.join(bundle, 'bin', `${file}.exe`))
            expect(resolver.resolveTool(name, settings)).toEqual({ command, source: 'bundled' })
        }
        expect(resolver.resolveTool('compiler', { compiler: 'my-g++' }).source).toBe('bundled')
    })

    it('searches Windows Path in order with executable suffixes and quoted entries', () => {
        const compiler = executable(path.join(system, 'g++.exe'))
        const resolver = new ToolchainResolver(bundle, { Path: `"${system}";${bundle}` }, 'win32')
        expect(resolver.resolveTool('compiler', settings)).toEqual({ command: compiler, source: 'path' })
        expect(resolver.resolveTool('compiler', { compiler: 'g++.exe' }).command).toBe(compiler)
        expect(() => resolver.resolveTool('clangd', settings)).toThrow('Cannot find clangd')
    })

    it('applies linker selection only to a resolved bundled compiler, preserving absolute overrides', () => {
        const root = path.join(directory, '中文安装'),
            command = executable(path.join(root, 'bin', 'g++.exe'))
        executable(path.join(root, 'bin', 'ld.lld.exe'))
        const resolver = new ToolchainResolver(root, {}, 'win32'),
            flags = ['-std=c++17']
        expect(resolver.resolveCompiler(settings, flags)).toEqual({
            command,
            source: 'bundled',
            flags: [...flags, '-fuse-ld=lld']
        })
        expect(resolver.resolveCompiler({ compiler: command }, flags)).toEqual({ command, source: 'configured', flags })
    })

    it('supports extensionless Linux/macOS tools and prepends a fresh, case-normalized child PATH', () => {
        const compiler = executable(path.join(bundle, 'bin', 'g++'))
        for (const platform of ['linux', 'darwin'] as const) {
            const resolver = new ToolchainResolver(bundle, { PATH: system }, platform)
            expect(resolver.resolveTool('compiler', settings)).toEqual({ command: compiler, source: 'bundled' })
            const bundled = executable(path.join(bundle, 'bin', 'clang-format'))
            expect(resolver.resolveTool('clangFormat', settings).command).toBe(bundled)
            expect(resolver.toolchainEnv().PATH).toBe(`${path.join(bundle, 'bin')}:${system}`)
        }
        const env = { Path: system, PATH: 'duplicate', ITER_TEST: 'kept' }
        const resolver = new ToolchainResolver(bundle, env, 'win32')
        expect(resolver.toolchainEnv()).toEqual({ Path: `${path.join(bundle, 'bin')};${system}`, ITER_TEST: 'kept' })
        expect(env.PATH).toBe('duplicate')
        expect(new ToolchainResolver(path.join(directory, 'absent'), env, 'win32').toolchainEnv().Path).toBe(system)
    })
})
