import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import type { PluginHost } from '../../shared/plugin'

const electron = vi.hoisted(() => {
    class Window {
        url = ''
        destroyed = false
        handlers = new Map<string, () => void>()
        constructor(readonly options: Record<string, unknown>) {
            state.windows.push(this)
        }
        webContents = { getURL: () => this.url }
        loadURL = vi.fn(async (url: string) => {
            this.url = url
        })
        isDestroyed = () => this.destroyed
        isMinimized = () => true
        restore = vi.fn()
        show = vi.fn()
        focus = vi.fn()
        on = (event: string, fn: () => void) => {
            this.handlers.set(event, fn)
        }
        destroy = vi.fn(() => {
            this.destroyed = true
            this.handlers.get('closed')?.()
        })
    }
    const state = { appPath: '', windows: [] as Window[], partition: vi.fn((name: string) => ({ partition: name })) }
    return { state, Window }
})
vi.mock('electron', () => ({
    app: { getAppPath: () => electron.state.appPath, getPath: () => path.join(electron.state.appPath, 'userData') },
    BrowserWindow: electron.Window,
    session: { fromPartition: electron.state.partition }
}))
import { PluginManager } from './manager'
import { listModes } from '../judge/modes/registry'
import { servePluginRequest } from './protocol'
import type { RuntimePluginHost } from './host'

const nativeRequire = createRequire(path.join(process.cwd(), 'package.json'))
const basic = `exports.activate = host => {
  exports.host = host;
  host.handle('echo', async source => source);
};`

describe('PluginManager', () => {
    let root: string
    let canonicalRoot: string
    let user: string
    let manager: PluginManager
    let notify: ReturnType<typeof vi.fn<(message: string) => void>>
    const managers: PluginManager[] = []

    async function plugin(
        id: string,
        code = basic,
        bundled = false,
        fields: Record<string, unknown> = {}
    ): Promise<string> {
        const directory = path.join(bundled ? path.join(root, 'plugins') : user, id)
        await fs.mkdir(directory, { recursive: true })
        await fs.writeFile(
            path.join(directory, 'iter-plugin.json'),
            JSON.stringify({ id, name: id, version: '1.0.0', main: 'index.cjs', ...fields })
        )
        await fs.writeFile(path.join(directory, 'index.cjs'), code)
        return directory
    }

    async function activatedEntry(
        directory: string
    ): Promise<{ host: RuntimePluginHost; stops?: number; stopped?: boolean }> {
        // Discovery loads this canonical filename. Requiring a differently cased Windows path
        // can create a second, unactivated module instead of returning the manager's instance.
        const filename = await fs.realpath(path.join(directory, 'index.cjs'))
        const cached = nativeRequire.cache[filename]
        expect(cached, `Expected an already loaded fixture: ${filename}`).toBeDefined()
        return cached!.exports
    }

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-plugins-'))
        canonicalRoot = await fs.realpath(root)
        // Exercise the Windows path alias that previously broke fixture inspection and cleanup.
        if (process.platform === 'win32') root = root.toLowerCase()
        user = path.join(root, 'user')
        electron.state.appPath = root
        electron.state.windows.length = 0
        electron.state.partition.mockClear()
        notify = vi.fn<(message: string) => void>()
        manager = new PluginManager(user, notify)
        managers.push(manager)
        vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(async () => {
        vi.useRealTimers()
        try {
            // Reload against empty roots to release fixture windows and plugin resources.
            await fs.rm(root, { recursive: true, force: true })
            for (const instance of managers.splice(0)) {
                if (typeof instance.dispose === 'function') await instance.dispose()
                else await instance.reload()
            }
        } finally {
            // Unlike startsWith(root), path.relative handles Windows casing differences. Use
            // the canonical root as well so symlinked temp directories cannot leak modules.
            for (const key of Object.keys(nativeRequire.cache)) {
                const relative = path.relative(canonicalRoot, key)
                if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
                    delete nativeRequire.cache[key]
            }
            vi.restoreAllMocks()
        }
    })

    it('discovers both roots, prefers user ids, activates async entries and invokes handlers', async () => {
        await plugin('same', basic, true, { name: 'bundled' })
        await plugin('bundled', basic, true)
        await plugin(
            'same',
            `exports.activate = async host => {
      await Promise.resolve(); host.handle('echo', async source => source);
    }`,
            false,
            { name: 'user' }
        )
        await manager.loadAll()
        expect(manager.list()).toEqual(
            expect.arrayContaining([
                { id: 'same', name: 'user', version: '1.0.0', enabled: true },
                { id: 'bundled', name: 'bundled', version: '1.0.0', enabled: true }
            ])
        )
        expect(manager.list()).toHaveLength(2)
        expect(await manager.invoke('same', 'echo', ['code'])).toBe('code')
    })

    it('loads an old manifest but never bypasses an invalid new manifest', async () => {
        const directory = await plugin('legacy')
        await fs.rename(path.join(directory, 'iter-plugin.json'), path.join(directory, 'naven-plugin.json'))
        await manager.loadAll()
        expect(await manager.invoke('legacy', 'echo', ['code'])).toBe('code')
        await fs.writeFile(path.join(directory, 'iter-plugin.json'), '{')
        await manager.reload()
        expect(manager.list()[0].error).toBeTruthy()
    })

    it('lists disabled plugins without activating them', async () => {
        await plugin('bundled', basic, true)
        const off = new PluginManager(
            user,
            notify,
            () => {},
            (id) => id !== 'bundled'
        )
        managers.push(off)
        await off.loadAll()
        expect(off.list()).toEqual([{ id: 'bundled', name: 'bundled', version: '1.0.0', enabled: false }])
        await expect(off.invoke('bundled', 'echo', [])).rejects.toMatchObject({
            message: expect.stringContaining('不可用')
        })
    })

    it('isolates invalid manifests, entry paths, exports and partial activation; broken user overrides stay broken', async () => {
        await plugin('valid')
        await plugin('bad-json')
        await fs.writeFile(path.join(user, 'bad-json/iter-plugin.json'), '{')
        await plugin('bad-name', basic, false, { name: '' })
        await plugin('bad-id', basic, false, { id: '../escape' })
        await plugin('escape', basic, false, { main: '../index.cjs' })
        await plugin('absent', basic, false, { main: 'missing.cjs' })
        await plugin('exports', 'module.exports = {}')
        await plugin('same', basic, true)
        await plugin(
            'same',
            basic + `\nexports.activate = host => { host.handle('partial',()=>true); throw new Error('broken'); }`
        )
        await manager.loadAll()
        expect(manager.list()).toHaveLength(8)
        expect(manager.list().filter((p) => p.error)).toHaveLength(7)
        expect(await manager.invoke('valid', 'echo', ['code'])).toBe('code')
        await expect(manager.invoke('same', 'partial', [])).rejects.toMatchObject({
            message: expect.stringContaining('broken')
        })
    })

    it('bounds plugin logs and returns independent copies', async () => {
        await plugin(
            'logs',
            basic +
                "\nconst activate=exports.activate;exports.activate=h=>{activate(h);for(let i=0;i<105;i++)h.log('line '+i);h.notify('hello')}"
        )
        await manager.loadAll()
        expect(manager.getLogs('logs')).toHaveLength(100)
        expect(manager.getLogs('logs')[0]).toBe('[plugin:logs] line 5')
        manager.getLogs('logs').pop()
        expect(manager.getLogs('logs')).toHaveLength(100)
        expect(notify).toHaveBeenCalledWith('hello')
    })

    it('times out stalled activation, cleans up once, and lets a queued call reach another plugin', async () => {
        const directory = await plugin(
            'a-stalled',
            `exports.activate = h => {
      exports.host=h; h.notify('activation-start'); return new Promise(()=>{});
    }; exports.deactivate = () => { exports.stops=(exports.stops || 0)+1; };`
        )
        await plugin('healthy')
        let started!: () => void
        const activation = new Promise<void>((resolve) => {
            started = resolve
        })
        notify.mockImplementation((message) => {
            if (message === 'activation-start') started()
        })
        vi.useFakeTimers()
        const loading = manager.loadAll()
        const invoking = manager.invoke('healthy', 'echo', ['ready'])
        await activation
        await vi.advanceTimersByTimeAsync(30_000)
        await loading
        expect(await invoking).toBe('ready')
        expect(manager.list().find((p) => p.id === 'a-stalled')?.error).toContain('activate() 超时')
        const entry = await activatedEntry(directory)
        expect(entry.stops).toBe(1)
        expect(() => entry.host.handle('late', () => true)).toThrow('已卸载')
        await fs.rm(directory, { recursive: true })
        await manager.reload()
        expect(entry.stops).toBe(1)
        expect(vi.getTimerCount()).toBe(0)
    })

    it('uses a persistent isolated session, reuses and focuses windows, recreates closed windows', async () => {
        const directory = await plugin('windows')
        await manager.loadAll()
        const { host } = await activatedEntry(directory)
        await expect(host.openWindow('file:///etc/passwd')).rejects.toThrow('HTTP')
        const first = await host.openWindow('https://example.com/a', { width: 900, show: false })
        expect(electron.state.windows).toHaveLength(1)
        const win = electron.state.windows[0]
        expect(win.options).toMatchObject({
            width: 900,
            show: false,
            webPreferences: {
                session: { partition: 'persist:iter-plugin-windows' },
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true
            }
        })
        expect(win.show).not.toHaveBeenCalled()
        expect(await host.openWindow('https://example.com/a')).toBe(first)
        expect(win.loadURL).toHaveBeenCalledTimes(1)
        expect(win.restore).toHaveBeenCalled()
        expect(win.focus).toHaveBeenCalled()
        await host.openWindow('https://example.com/b')
        expect(win.loadURL).toHaveBeenLastCalledWith('https://example.com/b')
        win.destroy()
        expect(await host.openWindow('https://example.com/a')).not.toBe(first)
        expect(electron.state.partition).toHaveBeenCalledTimes(2)
    })

    it('disposes all owned windows once even when another plugin deactivate throws', async () => {
        const first = await plugin(
            'a-window',
            basic + `\nexports.deactivate=()=>{exports.stops=(exports.stops||0)+1;throw new Error('cleanup failed')};`
        )
        const second = await plugin(
            'b-window',
            basic + `\nexports.deactivate=()=>{exports.stops=(exports.stops||0)+1};`
        )
        await manager.loadAll()
        const a = await activatedEntry(first),
            b = await activatedEntry(second)
        await a.host.openWindow('https://example.com/a')
        await b.host.openWindow('https://example.com/b')
        const disposing = manager.dispose()
        expect(manager.dispose()).toBe(disposing)
        await disposing
        expect(electron.state.windows.every((window) => window.destroyed)).toBe(true)
        expect(a.stops).toBe(1)
        expect(b.stops).toBe(1)
        expect(manager.list()).toEqual([])
        expect(manager.panels()).toEqual([])
        await expect(manager.reload()).rejects.toThrow('关闭')
        await expect(manager.loadAll()).rejects.toThrow('关闭')
        await expect(a.host.openWindow('https://example.com/late')).rejects.toThrow()
        await manager.dispose()
        expect(a.stops).toBe(1)
        expect(b.stops).toBe(1)
    })

    it('disposes during pending activation, cancels queued reloads and rejects late host activity', async () => {
        expect(manager.dispose).toBeTypeOf('function')
        const directory = await plugin(
            'a-starting',
            `exports.activate=async h=>{exports.host=h;
      await h.openWindow('https://example.com/starting'); h.notify('activation-start');
      await new Promise(resolve=>{exports.finish=resolve});
      try{await h.openWindow('https://example.com/late')}catch(error){exports.lateBlocked=true}
    };exports.deactivate=()=>{exports.stops=(exports.stops||0)+1};`
        )
        await plugin('z-never-started', `exports.activate=h=>h.notify('unexpected activation')`)
        let started!: () => void
        const activation = new Promise<void>((resolve) => {
            started = resolve
        })
        notify.mockImplementation((message) => {
            if (message === 'activation-start') started()
        })
        const loading = manager.loadAll()
        await activation
        const queued = manager.reload()
        const entry = (await activatedEntry(directory)) as Awaited<ReturnType<typeof activatedEntry>> & {
            finish(): void
            lateBlocked?: boolean
        }
        try {
            await manager.dispose()
            await Promise.all([loading, queued])
            expect(entry.stops).toBe(1)
            expect(electron.state.windows).toHaveLength(1)
            expect(electron.state.windows[0].destroyed).toBe(true)
            expect(notify).not.toHaveBeenCalledWith('unexpected activation')
            expect(manager.list()).toEqual([])
            entry.finish()
            await vi.waitFor(() => expect(entry.lateBlocked).toBe(true))
            expect(electron.state.windows).toHaveLength(1)
        } finally {
            entry.finish()
        }
    })

    it('does not let a stalled deactivate delay closing another plugin window', async () => {
        const slow = await plugin('a-slow-window', basic + '\nexports.deactivate=()=>new Promise(()=>{});')
        const fast = await plugin('b-fast-window')
        await manager.loadAll()
        await (await activatedEntry(slow)).host.openWindow('https://example.com/slow')
        await (await activatedEntry(fast)).host.openWindow('https://example.com/fast')
        vi.useFakeTimers()
        const disposing = manager.dispose()
        await vi.advanceTimersByTimeAsync(0)
        expect(electron.state.windows[1].destroyed).toBe(true)
        await vi.advanceTimersByTimeAsync(5_000)
        await disposing
        expect(electron.state.windows.every((window) => window.destroyed)).toBe(true)
        expect(vi.getTimerCount()).toBe(0)
    })

    it('deactivates, closes windows, clears helper caches, removes old registrations and invalidates old hosts on reload', async () => {
        const directory = await plugin(
            'reloadable',
            `exports.activate = h => {
      exports.host=h; h.handle(require('./helper.cjs'),()=>true);
    }; exports.deactivate = () => { exports.stopped=true; throw new Error('cleanup failed'); };`
        )
        await fs.writeFile(path.join(directory, 'helper.cjs'), "module.exports = 'old'")
        await manager.loadAll()
        const entry = await activatedEntry(directory)
        await entry.host.openWindow('https://example.com')
        await fs.writeFile(path.join(directory, 'helper.cjs'), "module.exports = 'new'")
        await manager.reload()
        expect(entry.stopped).toBe(true)
        expect(electron.state.windows[0].destroy).toHaveBeenCalled()
        expect(await manager.invoke('reloadable', 'new', [])).toBe(true)
        await expect(manager.invoke('reloadable', 'old', [])).rejects.toMatchObject({
            message: expect.stringContaining('未找到')
        })
        expect(() => entry.host.notify('stale')).toThrow('已卸载')
        await expect(entry.host.openWindow('https://example.com')).rejects.toThrow('已卸载')
        await fs.rm(directory, { recursive: true })
        await manager.reload()
        expect(manager.list()).toEqual([])
    })

    it('registers isolated panels with encoded URLs, validates entries and publishes changes', async () => {
        const changed = vi.fn()
        manager = new PluginManager(user, notify, changed)
        managers.push(manager)
        const directory = await plugin(
            'panels',
            `exports.activate = h => { exports.host=h;
      h.registerPanel({ id:'notes', title:'笔记', entry:'ui/my panel.html' }); };`
        )
        await fs.mkdir(path.join(directory, 'ui'))
        await fs.writeFile(path.join(directory, 'ui/my panel.html'), '<h1>Panel</h1>')
        await manager.loadAll()
        const { host } = await activatedEntry(directory)
        expect(manager.panels()).toEqual([
            { pluginId: 'panels', id: 'notes', title: '笔记', url: 'iter://plugins/panels/ui/my%20panel.html' }
        ])
        expect(changed).toHaveBeenCalled()
        manager.panels()[0].title = 'mutated'
        expect(manager.panels()[0].title).toBe('笔记')
        expect(() => host.registerPanel({ id: 'notes', title: 'Duplicate', entry: 'ui/my panel.html' })).toThrow('重复')
        for (const entry of [
            '../escape.html',
            '/absolute.html',
            'ui/../my panel.html',
            'C:/secret.html',
            'ui\\page.html',
            'index.cjs'
        ]) {
            expect(() => host.registerPanel({ id: 'bad', title: 'Bad', entry })).toThrow()
        }
        expect((await servePluginRequest(manager.panels()[0].url)).status).toBe(200)
    })

    it('isolates channels, supports sync and async handlers, normalizes thrown values and bounds calls at 30s', async () => {
        await plugin(
            'handlers',
            `exports.activate=h=>{exports.host=h;
      h.handle('sum',(a,b)=>a+b); h.handle('async',async x=>({x}));
      h.handle('error',()=>{throw new Error('broken')}); h.handle('string',()=>{throw 'oops'});
      h.handle('object',()=>Promise.reject({message:'structured',secret:'hidden'}));
      h.handle('slow',()=>new Promise(()=>{})); };`
        )
        await plugin('other', `exports.activate=h=>h.handle('sum',()=>99)`)
        await manager.loadAll()
        expect(await manager.invoke('handlers', 'sum', [2, 3])).toBe(5)
        expect(await manager.invoke('other', 'sum', [])).toBe(99)
        expect(await manager.invoke('handlers', 'async', ['hello'])).toEqual({ x: 'hello' })
        for (const [channel, message] of [
            ['error', 'broken'],
            ['string', 'oops'],
            ['object', 'structured']
        ]) {
            await expect(manager.invoke('handlers', channel, [])).rejects.toEqual({ message })
        }
        await expect(manager.invoke('handlers', 'missing', [])).rejects.toEqual({
            message: expect.stringContaining('handlers/missing')
        })
        await expect(manager.invoke('missing', 'sum', [])).rejects.toEqual({
            message: expect.stringContaining('插件不可用')
        })
        await expect(manager.invoke('handlers', 'sum', null as unknown as unknown[])).rejects.toEqual({
            message: expect.stringContaining('数组')
        })
        const { host } = await activatedEntry(path.join(user, 'handlers'))
        expect(() => host.handle('sum', () => {})).toThrow('重复')
        expect(() => host.handle('', () => {})).toThrow('channel')
        vi.useFakeTimers()
        expect(await manager.invoke('handlers', 'sum', [1, 1])).toBe(2)
        expect(vi.getTimerCount()).toBe(0)
        const pending = expect(manager.invoke('handlers', 'slow', [])).rejects.toEqual({
            message: expect.stringContaining('超时')
        })
        await vi.advanceTimersByTimeAsync(30_000)
        await pending
        expect(vi.getTimerCount()).toBe(0)
    })

    it('removes panels, assets, handlers and judge modes on reload and partial activation failure', async () => {
        const code = `exports.activate=h=>{exports.host=h;
      h.registerPanel({id:'panel',title:'Panel',entry:'panel.html'});
      h.handle('ping',()=>true);
      h.registerJudgeMode({id:'plugin-test-mode',name:'Test',detect:()=>undefined,run:()=>({}),describe:()=>({})});
    };`
        const directory = await plugin('contributions', code)
        await fs.writeFile(path.join(directory, 'panel.html'), '<p>Panel</p>')
        await manager.loadAll()
        const { host } = await activatedEntry(directory)
        expect(listModes()).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: 'plugin-test-mode', source: 'contributions' })])
        )
        await fs.writeFile(path.join(directory, 'index.cjs'), 'exports.activate=h=>{}')
        await manager.reload()
        expect(manager.panels()).toEqual([])
        await expect(manager.invoke('contributions', 'ping', [])).rejects.toMatchObject({
            message: expect.stringContaining('未找到')
        })
        expect(listModes().some((m) => m.id === 'plugin-test-mode')).toBe(false)
        expect(() => host.handle('stale', () => {})).toThrow('已卸载')
        expect(() => host.registerJudgeMode({} as Parameters<PluginHost['registerJudgeMode']>[0])).toThrow('已卸载')
        await fs.writeFile(
            path.join(directory, 'index.cjs'),
            code.replace(/\n    };/, "throw new Error('partial failure');\n    };")
        )
        await manager.reload()
        expect(manager.list()[0].error).toContain('partial failure')
        expect(manager.panels()).toEqual([])
        expect(listModes().some((m) => m.id === 'plugin-test-mode')).toBe(false)
        expect((await servePluginRequest('iter://plugins/contributions/panel.html')).status).toBe(404)
    })

    it('prevents plugin modes from adopting the non-removable builtin registry source', async () => {
        await plugin(
            'builtin',
            `exports.activate=h=>h.registerJudgeMode({
      id:'leaked-mode',name:'Leak',detect:()=>undefined,run:()=>({}),describe:()=>({})
    })`
        )
        await manager.loadAll()
        expect(manager.list()[0].error).toContain('保留来源')
        expect(listModes().some((mode) => mode.id === 'leaked-mode')).toBe(false)
        await manager.reload()
        expect(listModes().some((mode) => mode.source === 'builtin' && mode.id === 'standard')).toBe(true)
    })
})
