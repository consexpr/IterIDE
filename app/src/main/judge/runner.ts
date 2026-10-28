import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ToolchainSettings } from '../../shared/judge'
import { compileSource } from './compile'
import { resourceFile } from './resources'
import { cancellable } from './process'
import { resolveTool } from '../toolchain'
import { holdCachePath } from './cache-lru'

const helpers = new Map<string, Promise<string | undefined>>()
const helperControllers = new Set<AbortController>()
const helperReleases: (() => void)[] = []
let disposed = false,
    disposing: Promise<void> | undefined
/** Prefer the packaged binary; development installs can build the bundled source. */
export async function getRunner(tc: ToolchainSettings, signal?: AbortSignal): Promise<string | undefined> {
    if (disposed || signal?.aborted) return undefined
    if (process.platform === 'win32') {
        try {
            return await resourceFile('runner/runner.exe')
        } catch {
            /* lazy build below */
        }
    }
    let compiler: string
    try {
        compiler = resolveTool('compiler', tc).command
    } catch {
        return undefined
    }
    let pending = helpers.get(compiler)
    if (!pending) {
        const controller = new AbortController()
        helperControllers.add(controller)
        pending = (async () => {
            try {
                const sourcePath = await resourceFile('runner/runner.cpp')
                const source = await fs.readFile(sourcePath, 'utf8')
                const build = await compileSource(
                    sourcePath,
                    source,
                    { ...tc, flags: '-std=c++17 -O2' + (process.platform === 'win32' ? ' -static' : '') },
                    false,
                    process.platform === 'win32' ? '-lpsapi -lshell32' : '',
                    controller.signal
                )
                if (build.ok && build.exe) helperReleases.push(holdCachePath(build.exe))
                return build.ok ? build.exe : undefined
            } catch {
                return undefined
            } finally {
                helperControllers.delete(controller)
            }
        })()
        helpers.set(compiler, pending)
    }
    return cancellable(pending, signal)
}

/** App-owned shared builds outlive individual run cancellation, but never quit. */
export function disposeRunners(): Promise<void> {
    return (disposing ??= (async () => {
        disposed = true
        for (const controller of helperControllers) controller.abort()
        await Promise.allSettled([...helpers.values()])
        helpers.clear()
        for (const release of helperReleases.splice(0)) release()
    })())
}

/** Never silently execute Windows contestant/tool code without crash protection. */
export async function getPassthroughRunner(tc: ToolchainSettings, signal?: AbortSignal): Promise<string | undefined> {
    if (process.platform !== 'win32' || signal?.aborted) return undefined
    const runner = await getRunner(tc, signal)
    if (!runner && !signal?.aborted)
        throw new Error('Windows runner unavailable: build resources/runner/runner.exe with npm run build-runner')
    return runner
}

export interface Accounting {
    timeMs: number
    wallMs: number
    memoryKb: number
    exitCode: number
    signal: number
    status: 'ok' | 'time_limit' | 'memory_limit'
    /** True only if the helper killed the program at its wall-clock deadline. */
    wallTimedOut: boolean
}
export async function readAccounting(scratch: string): Promise<Accounting | undefined> {
    try {
        const value = JSON.parse(await fs.readFile(path.join(scratch, 'result.json'), 'utf8')) as Accounting
        return Number.isFinite(value.timeMs) &&
            Number.isFinite(value.wallMs) &&
            Number.isFinite(value.memoryKb) &&
            Number.isFinite(value.exitCode)
            ? value
            : undefined
    } catch {
        return undefined
    }
}
