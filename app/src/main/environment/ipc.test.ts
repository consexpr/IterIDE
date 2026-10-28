import { expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({
    handlers: new Map<string, (...args: any[]) => any>(),
    start: vi.fn(),
    state: vi.fn(() => ({ status: 'idle' })),
    cancel: vi.fn(),
    dispose: vi.fn(),
    calls: [] as any[],
    emit: undefined as undefined | ((state: unknown) => void)
}))
vi.mock('electron', () => ({
    app: { isPackaged: false, getAppPath: () => '.', getPath: () => '.', getVersion: () => 'test' },
    dialog: {},
    shell: {},
    ipcMain: {
        handle: (name: string, handler: (...args: any[]) => any) => fake.handlers.set(name, handler),
        on: vi.fn()
    }
}))
vi.mock('./manager', () => ({
    EnvironmentHealthService: class {
        constructor(getTools: () => unknown, version: string, emit: (state: unknown) => void) {
            fake.calls.push([getTools, version])
            fake.emit = emit
        }
        start = fake.start
        state = fake.state
        cancel = fake.cancel
        dispose = fake.dispose
    }
}))
vi.mock('../judge/engine', () => ({
    JudgeEngine: class {
        async dispose() {}
    }
}))
vi.mock('../debug/manager', () => ({
    DebugManager: class {
        async dispose() {}
    }
}))
vi.mock('../plugins/manager', () => ({
    PluginManager: class {
        async loadAll() {}
        async dispose() {}
    }
}))
vi.mock('../lsp/clangd', () => ({
    ClangdBridge: class {
        async stop() {}
    }
}))
vi.mock('../sync', () => ({
    SyncManager: class {
        async dispose() {}
    }
}))
import { registerIpc } from '../ipc'
import type { SettingsStore } from '../settings'

it('registers manual health endpoints without starting checks and owns cleanup on shutdown', async () => {
    const send = vi.fn(),
        toolchain = { compiler: 'configured' }
    const entry = 'file:///iter/renderer/index.html'
    const mainFrame = { url: entry }
    const webContents = { send, mainFrame, isDestroyed: () => false }
    const event = { sender: webContents, senderFrame: mainFrame }
    const settings = { get: () => ({ toolchain }), userDirs: () => ({ plugins: '.' }) } as unknown as SettingsStore
    const services = registerIpc(() => ({ isDestroyed: () => false, webContents }) as any, settings, undefined, entry)
    expect(fake.start).not.toHaveBeenCalled()
    expect(fake.calls[0][0]()).toBe(toolchain)
    expect(fake.calls[0][1]).toBe('test')
    // Every invoke endpoint rejects foreign windows and subframes before running its implementation.
    for (const [name, handler] of fake.handlers) {
        if (name === 'app:resolveClose') {
            await expect(handler({}, 'id', 'ready')).rejects.toThrow('Invalid close response')
        } else {
            expect(() => handler({})).toThrow('Untrusted IPC sender')
            expect(() => handler({ sender: webContents, senderFrame: { url: entry } })).toThrow('Untrusted IPC sender')
        }
    }
    expect(await fake.handlers.get('toolchain:healthState')!(event)).toEqual({ status: 'idle' })
    await fake.handlers.get('toolchain:check')!(event)
    await fake.handlers.get('toolchain:cancelCheck')!(event)
    expect(fake.start).toHaveBeenCalledOnce()
    expect(fake.cancel).toHaveBeenCalledOnce()
    fake.emit?.({ revision: 2, status: 'running' })
    expect(send).toHaveBeenCalledWith('toolchain:health', { revision: 2, status: 'running' })
    await Promise.all([services.dispose(), services.dispose()])
    expect(fake.dispose).toHaveBeenCalledOnce()
})
