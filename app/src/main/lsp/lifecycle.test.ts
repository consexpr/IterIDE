import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ClangdBridge } from './clangd'
import { probeCompiler } from './toolchain'
vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('../toolchain', () => ({ resolveTool: (name: string) => ({ command: name }), toolchainEnv: () => ({}) }))
vi.mock('./toolchain', () => ({ probeCompiler: vi.fn() }))
let bridge: ClangdBridge, finish: (() => void) | undefined
beforeEach(() => {
    vi.resetAllMocks()
    finish = undefined
    bridge = new ClangdBridge(() => {})
})
afterEach(async () => {
    finish?.()
    await bridge.stop()
})
it('aborts compiler discovery and waits for its process cleanup before stop resolves', async () => {
    let signal: AbortSignal | undefined
    vi.mocked(probeCompiler).mockImplementation(async (_compiler, abort) => {
        signal = abort
        return new Promise((resolve) => {
            finish = () => resolve([])
        })
    })
    const starting = bridge.start(path.resolve('.'), 'clangd')
    await vi.waitFor(() => expect(probeCompiler).toHaveBeenCalledOnce())
    let stopped = false
    const stopping = bridge.stop().then(() => {
        stopped = true
    })
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(signal?.aborted).toBe(true)
    expect(stopped).toBe(false)
    finish!()
    await stopping
    expect(await starting).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
})
it('joins repeated stops during discovery without a start/stop dependency cycle', async () => {
    vi.mocked(probeCompiler).mockImplementation(
        async (_compiler, signal) =>
            new Promise((resolve) => {
                finish = () => resolve([])
                signal?.addEventListener('abort', finish, { once: true })
            })
    )
    const starting = bridge.start(path.resolve('.'), 'clangd')
    await vi.waitFor(() => expect(probeCompiler).toHaveBeenCalledOnce())
    await Promise.all([bridge.stop(), bridge.stop(), starting])
    expect(spawn).not.toHaveBeenCalled()
})
