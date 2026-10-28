import { app, BrowserWindow, session } from 'electron'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promises as fs, realpathSync, statSync } from 'node:fs'
import type { PanelInfo } from '../../shared/plugin'
import { registerMode, unregisterSource } from '../judge/modes/registry'
import { discover, errorMessage, type PluginCandidate } from './discovery'
import type { RuntimePluginHost } from './host'
import { isInside, pluginFilePath } from './paths'
import { registerPluginAssets, unregisterPluginAssets } from './protocol'

interface LoadedPlugin extends PluginCandidate {
    active: boolean
    panels: Map<string, PanelInfo>
    handlers: Map<string, (...args: unknown[]) => unknown>
    logs: string[]
    deactivate?: () => unknown
    window?: BrowserWindow
    navigation?: Promise<void>
    unloading?: Promise<void>
}

const MAX_LOG_LINES = 100

async function withTimeout<T>(
    work: () => T | PromiseLike<T>,
    milliseconds: number,
    message: string,
    signal?: AbortSignal
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    try {
        return await Promise.race([
            Promise.resolve().then(() => {
                if (signal?.aborted) throw new Error('插件管理器已关闭')
                return work()
            }),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(message)), milliseconds)
            }),
            ...(signal
                ? [
                      new Promise<never>((_resolve, reject) => {
                          abort = () => reject(new Error('插件管理器已关闭'))
                          if (signal.aborted) abort()
                          else signal.addEventListener('abort', abort, { once: true })
                      })
                  ]
                : [])
        ])
    } finally {
        clearTimeout(timer)
        if (abort) signal?.removeEventListener('abort', abort)
    }
}

export class PluginManager {
    private readonly plugins = new Map<string, LoadedPlugin>()
    private loading: Promise<void> = Promise.resolve()
    private stopped = false
    private disposing?: Promise<void>
    private readonly stopping = new AbortController()

    constructor(
        private readonly userPluginDir: string,
        private readonly notify: (msg: string) => void,
        private readonly changed: () => void = () => {},
        /** Disabled plugins are listed but never activated. */
        private readonly isEnabled: (id: string) => boolean = () => true
    ) {}

    panels(): PanelInfo[] {
        if (this.stopped) return []
        return [...this.plugins.values()]
            .filter((p) => p.active && !p.error)
            .flatMap((p) => [...p.panels.values()].map((panel) => ({ ...panel })))
    }
    async invoke(pluginId: string, channel: string, args: unknown[]): Promise<unknown> {
        try {
            if (this.stopped) throw new Error('插件管理器已关闭')
            await this.loading
            const plugin = this.plugins.get(pluginId)
            if (!plugin?.active || plugin.error) throw new Error(plugin?.error || `插件不可用: ${pluginId}`)
            const handler = plugin.handlers.get(channel)
            if (!handler) throw new Error(`未找到插件处理器: ${pluginId}/${channel}`)
            if (!Array.isArray(args)) throw new Error('invoke 的 args 必须是数组')
            return await withTimeout(() => handler(...args), 30_000, `插件调用超时（30 秒）: ${pluginId}/${channel}`)
        } catch (error) {
            throw { message: errorMessage(error) }
        }
    }

    loadAll(): Promise<void> {
        if (this.stopped) return Promise.reject(new Error('插件管理器已关闭'))
        // Serialize reloads and let handler calls wait for an in-progress load.
        this.loading = this.loading.catch(() => {}).then(() => (this.stopped ? undefined : this.load()))
        return this.loading
    }

    reload(): Promise<void> {
        return this.loadAll()
    }

    /** Stop admission before awaiting loaders; every plugin gets its own cleanup attempt. */
    dispose(): Promise<void> {
        if (this.disposing) return this.disposing
        this.stopped = true
        this.stopping.abort()
        const current = Promise.allSettled([...this.plugins.values()].map((plugin) => this.unload(plugin)))
        const work = (async () => {
            await this.loading.catch(() => {})
            const late = await Promise.allSettled([...this.plugins.values()].map((plugin) => this.unload(plugin)))
            const results = [...(await current), ...late]
            const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
            if (failures.length)
                throw new AggregateError(
                    failures.map((result) => result.reason),
                    '无法完成插件清理'
                )
            this.plugins.clear()
            this.changed()
        })()
        this.disposing = work
        // A transient window destruction failure may be retried, while successful disposal stays memoized.
        void work.catch(() => {
            if (this.disposing === work) this.disposing = undefined
        })
        return work
    }

    list(): { id: string; name: string; version: string; enabled: boolean; error?: string }[] {
        return [...this.plugins.values()].map(({ manifest, error }) => ({
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            enabled: this.isEnabled(manifest.id),
            ...(error ? { error } : {})
        }))
    }

    getLogs(pluginId: string): string[] {
        return [...(this.plugins.get(pluginId)?.logs ?? [])]
    }

    private log(plugin: LoadedPlugin, message: string): void {
        for (const line of String(message).split(/\r?\n/)) {
            const prefixed = `[plugin:${plugin.manifest.id}] ${line}`
            plugin.logs.push(prefixed)
            console.log(prefixed)
        }
        plugin.logs.splice(0, Math.max(0, plugin.logs.length - MAX_LOG_LINES))
    }

    private host(plugin: LoadedPlugin): RuntimePluginHost {
        const assertActive = (): void => {
            if (this.stopped || !plugin.active) throw new Error(`插件已卸载: ${plugin.manifest.id}`)
        }
        return {
            dataDir: path.join(app.getPath('userData'), 'plugin-data', plugin.manifest.id),
            registerJudgeMode: (mode) => {
                assertActive()
                // The judge registry deliberately never unregisters its built-in source.
                if (plugin.manifest.id === 'builtin') throw new Error('builtin 是内置评测模式的保留来源，请更换插件 id')
                registerMode(plugin.manifest.id, mode)
            },
            registerPanel: (panel) => {
                assertActive()
                if (
                    !panel ||
                    typeof panel.id !== 'string' ||
                    !panel.id.trim() ||
                    typeof panel.title !== 'string' ||
                    !panel.title.trim() ||
                    typeof panel.entry !== 'string'
                ) {
                    throw new Error('registerPanel 需要 id、title 和 entry')
                }
                if (plugin.panels.has(panel.id)) throw new Error(`重复的面板 id: ${panel.id}`)
                const file = pluginFilePath(plugin.directory, panel.entry)
                if (
                    !file ||
                    !/\.html?$/i.test(file) ||
                    !isInside(plugin.directory, realpathSync(file)) ||
                    !statSync(file).isFile()
                ) {
                    throw new Error('面板 entry 必须是插件目录内的 HTML 文件')
                }
                plugin.panels.set(panel.id, {
                    pluginId: plugin.manifest.id,
                    id: panel.id,
                    title: panel.title,
                    url: `iter://plugins/${encodeURIComponent(plugin.manifest.id)}/${panel.entry.split('/').map(encodeURIComponent).join('/')}`
                })
                this.changed()
            },
            handle: (channel, fn) => {
                assertActive()
                if (typeof channel !== 'string' || !channel.trim() || typeof fn !== 'function')
                    throw new Error('handle 需要非空 channel 和函数')
                if (plugin.handlers.has(channel)) throw new Error(`重复的插件处理器: ${channel}`)
                plugin.handlers.set(channel, fn)
            },
            openWindow: async (url, opts = {}) => {
                assertActive()
                const parsed = new URL(url)
                if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('插件窗口仅支持 HTTP/HTTPS URL')
                let win = plugin.window
                if (!win || win.isDestroyed()) {
                    win = new BrowserWindow({
                        width: opts.width ?? 1100,
                        height: opts.height ?? 800,
                        show: opts.show ?? true,
                        webPreferences: {
                            session: session.fromPartition(`persist:iter-plugin-${plugin.manifest.id}`),
                            nodeIntegration: false,
                            contextIsolation: true,
                            sandbox: true
                        }
                    })
                    plugin.window = win
                    const owned = win
                    win.on('closed', () => {
                        if (plugin.window === owned) {
                            plugin.window = undefined
                            plugin.navigation = undefined
                        }
                    })
                }
                if (opts.show !== false) {
                    if (win.isMinimized()) win.restore()
                    win.show()
                    win.focus()
                }
                if (win.webContents.getURL() !== parsed.href) plugin.navigation = win.loadURL(parsed.href)
                await plugin.navigation
                assertActive()
                return win
            },
            log: (message) => this.log(plugin, message),
            notify: (message) => {
                assertActive()
                this.notify(message)
            }
        }
    }

    private unload(plugin: LoadedPlugin): Promise<void> {
        if (plugin.unloading) return plugin.unloading
        const work = this.unloadPlugin(plugin)
        plugin.unloading = work
        void work.catch(() => {
            if (plugin.unloading === work) plugin.unloading = undefined
        })
        return work
    }

    private async unloadPlugin(plugin: LoadedPlugin): Promise<void> {
        plugin.active = false
        const hadPanels = plugin.panels.size > 0
        plugin.panels.clear()
        plugin.handlers.clear()
        const deactivate = plugin.deactivate
        plugin.deactivate = undefined
        try {
            unregisterPluginAssets(plugin.manifest.id)
            unregisterSource(plugin.manifest.id)
            if (hadPanels) this.changed()
        } finally {
            try {
                if (deactivate) await withTimeout(deactivate, 5_000, 'deactivate() 超时')
            } catch (error) {
                this.log(plugin, `deactivate() 失败: ${errorMessage(error)}`)
            } finally {
                if (plugin.window && !plugin.window.isDestroyed()) plugin.window.destroy()
                plugin.window = undefined
                plugin.navigation = undefined
            }
        }
    }

    private async load(): Promise<void> {
        if (this.stopped) return
        for (const plugin of this.plugins.values()) {
            await this.unload(plugin)
            if (this.stopped) return
        }
        this.plugins.clear()
        const bundledDir = path.join(app.getAppPath(), 'plugins')
        const roots =
            path.resolve(bundledDir) === path.resolve(this.userPluginDir)
                ? [bundledDir]
                : [bundledDir, this.userPluginDir]
        const candidates = new Map<string, PluginCandidate>()
        for (const root of roots) {
            for (const candidate of await discover(root)) candidates.set(candidate.manifest.id, candidate)
            if (this.stopped) return
        }
        const nativeRequire = createRequire(path.join(app.getAppPath(), 'package.json'))
        for (const candidate of candidates.values()) {
            if (this.stopped) return
            const plugin: LoadedPlugin = {
                ...candidate,
                active: false,
                logs: [],
                panels: new Map(),
                handlers: new Map()
            }
            this.plugins.set(plugin.manifest.id, plugin)
            if (plugin.error) {
                this.log(plugin, plugin.error)
                continue
            }
            if (!this.isEnabled(plugin.manifest.id)) continue
            try {
                await fs.mkdir(path.join(app.getPath('userData'), 'plugin-data', plugin.manifest.id), {
                    recursive: true
                })
                if (this.stopped) return
                // Evict local helpers too; dependencies outside this plugin retain their shared cache.
                for (const key of Object.keys(nativeRequire.cache)) {
                    const relative = path.relative(plugin.directory, key)
                    if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
                        delete nativeRequire.cache[key]
                }
                const entry = nativeRequire(plugin.entry!)
                if (typeof entry?.activate !== 'function') throw new Error('CommonJS 入口必须导出 activate(host)')
                if (entry.deactivate !== undefined && typeof entry.deactivate !== 'function')
                    throw new Error('deactivate 必须是函数')
                plugin.deactivate = entry.deactivate?.bind(entry)
                plugin.active = true
                registerPluginAssets(plugin.manifest.id, plugin.directory)
                await withTimeout(
                    () => entry.activate(this.host(plugin)),
                    30_000,
                    'activate() 超时（30 秒）',
                    this.stopping.signal
                )
            } catch (error) {
                plugin.error = `激活插件失败: ${errorMessage(error)}`
                this.log(plugin, plugin.error)
                await this.unload(plugin)
            }
        }
        this.changed()
    }
}
