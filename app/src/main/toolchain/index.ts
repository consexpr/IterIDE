import { constants, accessSync, statSync } from 'node:fs'
import path from 'node:path'
import type { ToolchainSettings, ToolName, ResolvedTool } from '../../shared/judge'
import { compilerFlags } from './linker'

const binaries: Record<ToolName, string> = {
    compiler: 'g++',
    gdb: 'gdb',
    clangd: 'clangd',
    clangFormat: 'clang-format'
}
export interface ResolvedCompiler extends ResolvedTool {
    flags: string[]
}

/** Injectable filesystem roots/environment keep resolution independent of Electron and testable. */
export class ToolchainResolver {
    constructor(
        readonly bundledRoot: string,
        private readonly env: NodeJS.ProcessEnv = process.env,
        private readonly platform: NodeJS.Platform = process.platform
    ) {}

    private usable(file: string): boolean {
        try {
            if (!statSync(file).isFile()) return false
            accessSync(file, this.platform === 'win32' ? constants.F_OK : constants.X_OK)
            return true
        } catch {
            return false
        }
    }

    resolveTool<K extends ToolName>(name: K, settings: Pick<ToolchainSettings, K>): ResolvedTool {
        const configured = settings[name].trim()
        if (path.isAbsolute(configured)) {
            if (this.usable(configured)) return { command: configured, source: 'configured' }
            throw new Error(`Configured ${name} is missing or not executable: ${configured}`)
        }
        if (!configured || /[\\/]/.test(configured)) {
            throw new Error(`Configure ${name} with an absolute executable path or a bare command name`)
        }
        const bundled = path.join(this.bundledRoot, 'bin', binaries[name] + (this.platform === 'win32' ? '.exe' : ''))
        if (this.usable(bundled)) return { command: bundled, source: 'bundled' }
        const pathKey =
            this.platform === 'win32' ? Object.keys(this.env).find((key) => key.toLowerCase() === 'path') : 'PATH'
        const extensions = this.platform === 'win32' && !path.extname(configured) ? ['.exe', '.com'] : ['']
        for (const directory of (this.env[pathKey ?? 'PATH'] ?? '').split(this.platform === 'win32' ? ';' : ':')) {
            if (!directory.trim()) continue
            for (const extension of extensions) {
                const candidate = path.resolve(directory.replace(/^"|"$/g, ''), configured + extension)
                if (this.usable(candidate)) return { command: candidate, source: 'path' }
            }
        }
        throw new Error(
            `Cannot find ${name} (${configured}). Install the bundled toolchain or configure an absolute path.`
        )
    }

    resolveCompiler(settings: Pick<ToolchainSettings, 'compiler'>, flags: readonly string[]): ResolvedCompiler {
        const tool = this.resolveTool('compiler', settings)
        return { ...tool, flags: compilerFlags(tool, flags, this.platform) }
    }

    toolchainEnv(): NodeJS.ProcessEnv {
        const env = { ...this.env }
        const keys = Object.keys(env).filter((key) => key.toLowerCase() === 'path')
        const key = this.platform === 'win32' ? (keys[0] ?? 'PATH') : 'PATH'
        const bin = path.join(this.bundledRoot, 'bin')
        if (this.platform === 'win32') for (const duplicate of keys) if (duplicate !== key) delete env[duplicate]
        try {
            if (statSync(bin).isDirectory())
                env[key] = [bin, env[key]].filter(Boolean).join(this.platform === 'win32' ? ';' : ':')
        } catch {
            /* Development installs can omit the bundled toolchain. */
        }
        return env
    }
}

let resolver = new ToolchainResolver(path.resolve('resources/toolchain'))

/** Main IPC initializes this once using app.isPackaged/app.getAppPath(). */
export function configureToolchain(bundledRoot: string): void {
    resolver = new ToolchainResolver(bundledRoot)
}
export function resolveTool<K extends ToolName>(name: K, settings: Pick<ToolchainSettings, K>): ResolvedTool {
    return resolver.resolveTool(name, settings)
}
export function resolveCompiler(
    settings: Pick<ToolchainSettings, 'compiler'>,
    flags: readonly string[]
): ResolvedCompiler {
    return resolver.resolveCompiler(settings, flags)
}
export function toolchainEnv(): NodeJS.ProcessEnv {
    return resolver.toolchainEnv()
}
