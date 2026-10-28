import { expect, it, vi } from 'vitest'
import { JudgeEngine } from './engine'
import { checkSyntax } from './compile'
import { createModeContext } from './modes/context'
import { acquireProblemLease } from '../problem/store'
import type { ToolchainSettings } from '../../shared/judge'
vi.mock('../problem/store', () => ({
    acquireProblemLease: vi.fn(async () => vi.fn()),
    loadProblem: vi.fn(async () => ({}))
}))
vi.mock('./compile', () => ({ checkSyntax: vi.fn() }))
vi.mock('./flags', () => ({ compileArgsFor: vi.fn(async () => []) }))
vi.mock('./modes/registry', () => ({ getMode: vi.fn(() => ({})) }))
vi.mock('./modes/context', () => ({ createModeContext: vi.fn() }))
it('idempotently disposes standalone compilation and syntax checks and releases the problem lease', async () => {
    const signals: AbortSignal[] = [],
        release = vi.fn(),
        disposeContext = vi.fn()
    vi.mocked(acquireProblemLease).mockResolvedValue(release)
    vi.mocked(createModeContext).mockImplementation(async (...args) => {
        const signal = args[5]
        signals.push(signal)
        return {
            context: {
                compile: () =>
                    new Promise((resolve) =>
                        signal.addEventListener('abort', () => resolve({ ok: false, output: 'Stopped' }), {
                            once: true
                        })
                    )
            },
            dispose: disposeContext
        } as never
    })
    vi.mocked(checkSyntax).mockImplementation(async (_src, _code, _tools, signal) => {
        signals.push(signal)
        return new Promise((resolve) => signal.addEventListener('abort', () => resolve([]), { once: true }))
    })
    const engine = new JudgeEngine(
        () => ({}) as ToolchainSettings,
        () => {}
    )
    const compile = engine.compile('main.cpp', '', false),
        syntax = engine.syntaxCheck('main.cpp', '')
    for (let i = 0; i < 10 && signals.length < 2; i++) await Promise.resolve()
    expect(signals).toHaveLength(2)
    const first = engine.dispose()
    expect(engine.dispose()).toBe(first)
    await first
    await Promise.all([compile, syntax])
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(release).toHaveBeenCalledOnce()
    expect(disposeContext).toHaveBeenCalledOnce()
    await expect(engine.run({ sourcePath: 'main.cpp', source: '' })).rejects.toThrow('disposed')
})
