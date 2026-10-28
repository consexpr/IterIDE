import { beforeEach, expect, it, vi } from 'vitest'
import { openTerminalWindow } from './window'

const fake = vi.hoisted(() => ({ windows: [] as any[] }))
vi.mock('../branding', () => ({ appIcon: () => 'resources/icon.png' }))
vi.mock('electron', async () => {
    const { EventEmitter } = await import('node:events')
    class Window extends EventEmitter {
        destroyed = false
        webContents = Object.assign(new EventEmitter(), {
            ipc: new EventEmitter(),
            send: vi.fn(),
            isDestroyed: () => this.destroyed,
            setWindowOpenHandler: vi.fn()
        })
        constructor() {
            super()
            fake.windows.push(this)
        }
        removeMenu() {}
        show() {}
        loadURL = vi.fn(async () => {})
        isDestroyed() {
            return this.destroyed
        }
        destroy() {
            this.destroyed = true
            this.emit('closed')
        }
        close() {
            this.destroy()
        }
    }
    return { app: { isPackaged: true }, BrowserWindow: Window, shell: { openExternal: vi.fn() } }
})
vi.mock('../security', () => ({
    trustedSender: (event: { trusted?: boolean }) => event.trusted === true,
    externalUrl: (url: string) => url
}))

beforeEach(() => {
    fake.windows.length = 0
})
async function fixture() {
    const opening = openTerminalWindow([])
    const win = fake.windows[0]
    win.webContents.ipc.emit('terminal:ready', { trusted: true }, { cols: 80, rows: 24 })
    return { view: await opening, win }
}
it('releases output only for its trusted acknowledgement and settles writes on close', async () => {
    const { view, win } = await fixture()
    let finished = false
    const write = view.write(new Uint8Array([1, 2])).then(() => {
        finished = true
    })
    const [channel, data, id] = win.webContents.send.mock.calls[0]
    expect(channel).toBe('terminal:data')
    expect(data).toEqual(new Uint8Array([1, 2]))
    win.webContents.ipc.emit('terminal:ack', { trusted: false }, id)
    win.webContents.ipc.emit('terminal:ack', { trusted: true }, id + 1)
    await Promise.resolve()
    expect(finished).toBe(false)
    win.webContents.ipc.emit('terminal:ack', { trusted: true }, id)
    await write
    const pending = view.write(new Uint8Array([3]))
    view.close()
    await Promise.all([pending, view.closed])
    const calls = win.webContents.send.mock.calls.length
    await view.write(new Uint8Array([4]))
    expect(win.webContents.send).toHaveBeenCalledTimes(calls)
})
it('settles a stalled output acknowledgement when its renderer crashes', async () => {
    const { view, win } = await fixture()
    const pending = view.write(new Uint8Array([1]))
    win.webContents.isDestroyed = () => true
    win.webContents.emit('render-process-gone')
    await Promise.all([pending, view.closed])
    expect(win.isDestroyed()).toBe(true)
})
