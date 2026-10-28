import { execFile } from 'node:child_process'
import type { ToolchainSettings, ToolchainStatus, ToolName } from '../../shared/judge'
import { resolveTool, toolchainEnv } from './index'

export async function toolchainStatus(settings: ToolchainSettings): Promise<ToolchainStatus> {
    const names: ToolName[] = ['compiler', 'gdb', 'clangd', 'clangFormat']
    const entries = await Promise.all(
        names.map(async (name) => {
            try {
                const tool = resolveTool(name, settings)
                const version = await new Promise<string>((resolve, reject) => {
                    execFile(
                        tool.command,
                        ['--version'],
                        { env: toolchainEnv(), windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024 },
                        (error, stdout, stderr) => {
                            if (error) reject(new Error(`Cannot read ${name} version: ${error.message}`))
                            else resolve((stdout || stderr).trim().split(/\r?\n/)[0] || 'Unknown version')
                        }
                    )
                })
                return [name, { ...tool, version }] as const
            } catch (error) {
                return [name, { error: (error as Error).message }] as const
            }
        })
    )
    return Object.fromEntries(entries) as ToolchainStatus
}
