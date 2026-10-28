import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { indentationSettings } from '../../shared/indentation'
import { defaultSettings, type AppSettings } from '../../shared/settings'
import { resolveTool, toolchainEnv } from '../toolchain'
import { frameMessage, LspMessageParser } from './framing'
import { probeCompiler } from './toolchain'
import { compileArgsFor } from '../judge/flags'
import { FormattingDocuments } from './formatting'
import { killTree } from '../debug/process'
import { sourceCompileContext } from '../toolchain/context'

type RpcMessage = { method?: string; params?: any; id?: number | string }

/** A stdio transport plus compiler setup. No Electron dependency. */
export class ClangdBridge {
    private child?: ChildProcessWithoutNullStreams
    private root = ''
    private executable = ''
    private compiler = 'g++'
    private resolvedCompiler = 'g++'
    private flags = '-std=c++17 -O2 -Wall -Wextra -Wshadow'
    private driverFlags: string[] = []
    private documents = new Set<string>()
    private readonly openingDocuments = new Map<string, unknown[]>()
    private readonly compileRevisions = new Map<string, number>()
    private readonly compileCommands = new Map<string, string>()
    private readonly compileTasks = new Map<string, Promise<void>>()
    private generation = 0
    private restarts = 0
    private retryTimer?: ReturnType<typeof setTimeout>
    private starting?: Promise<boolean>
    private probeAbort?: AbortController
    private stopping = true
    private stoppingTask?: Promise<void>
    private formatting = new FormattingDocuments()
    private readonly preparingFormats = new Set<number | string>()
    private readonly cancelledFormats = new Set<number | string>()
    private readonly formatTasks = new Set<Promise<void>>()

    constructor(
        private readonly onMessage: (m: unknown) => void,
        private readonly getFormatSettings: () => AppSettings = defaultSettings
    ) {}

    /** Call with settings.toolchain before start; defaults use g++ on PATH. */
    setToolchain(compiler: string, flags: string): void {
        if (this.compiler !== compiler) {
            this.compiler = compiler
            this.resolvedCompiler = compiler
            this.driverFlags = []
            void this.stop()
        }
        this.setFlags(flags)
    }

    setFlags(flags: string): void {
        if (flags === this.flags) return
        this.flags = flags
        for (const uri of this.documents) {
            try {
                void this.refreshCompileFlags(fileURLToPath(uri)).catch((error) => this.compileError(error))
            } catch {
                /* Only file documents have compile commands. */
            }
        }
    }

    async start(rootDir: string, clangdPath: string): Promise<boolean> {
        try {
            const executable = resolveTool('clangd', { clangd: clangdPath }).command
            const root = path.resolve(rootDir)
            if (this.root === root && this.executable === executable) {
                if (this.starting) return await this.starting
                if (this.child && !this.child.killed) return true
            }
            // Set the key/task before the first await, so concurrent IPC starts reuse one process.
            const stopped = this.stop()
            this.root = root
            this.executable = executable
            this.stopping = false
            this.restarts = 0
            const generation = this.generation
            const compiler = this.compiler
            const probeAbort = new AbortController()
            this.probeAbort = probeAbort
            const task = (async () => {
                await stopped
                if (generation !== this.generation || this.stopping || probeAbort.signal.aborted) return false
                const resolvedCompiler = resolveTool('compiler', { compiler }).command
                const driverFlags = await probeCompiler(resolvedCompiler, probeAbort.signal)
                if (generation !== this.generation || this.stopping) return false
                this.resolvedCompiler = resolvedCompiler
                this.driverFlags = driverFlags
                const spawned = await this.spawnServer(generation)
                return spawned && generation === this.generation && !this.stopping
            })()
                .catch(() => false)
                .finally(() => {
                    if (this.starting === task) this.starting = undefined
                    if (this.probeAbort === probeAbort) this.probeAbort = undefined
                })
            this.starting = task
            const ok = await task
            if (!ok && generation === this.generation) this.emitStatus('fallback')
            return ok
        } catch {
            await this.stop()
            this.emitStatus('fallback')
            return false
        }
    }

    /** Replace a server that stopped answering, or bring one back after the automatic retries gave up. */
    async restart(clangdPath: string): Promise<boolean> {
        const root = this.root
        if (!root) return false
        const child = this.child
        if (child && !this.stopping) {
            // The close handler respawns it and announces 'restarted'.
            this.restarts = 0
            await killTree(child)
            return true
        }
        return this.start(root, clangdPath)
    }

    send(message: unknown): void {
        if (!message || typeof message !== 'object') return
        const m = message as RpcMessage
        if (
            (m.method === 'textDocument/formatting' || m.method === 'textDocument/rangeFormatting') &&
            m.id !== undefined &&
            typeof m.params?.iterSource === 'string'
        ) {
            const task = this.format(m).finally(() => this.formatTasks.delete(task))
            this.formatTasks.add(task)
            return
        }
        if (m.method === '$/cancelRequest' && this.preparingFormats.has(m.params?.id)) {
            this.cancelledFormats.add(m.params.id)
            return
        }
        if (m.method === '$/cancelRequest') {
            for (const queue of this.openingDocuments.values()) {
                const index = queue.findIndex((message) => (message as RpcMessage).id === m.params?.id)
                if (index >= 0) {
                    queue.splice(index, 1)
                    return
                }
            }
        }
        if (m.method === 'workspace/didChangeConfiguration') {
            const flags = m.params?.settings?.iter?.flags
            if (typeof flags === 'string') this.setFlags(flags)
        }
        if (m.method === 'textDocument/didOpen') {
            const uri = m.params?.textDocument?.uri
            if (typeof uri === 'string') {
                this.documents.add(uri)
                const pending = this.openingDocuments.get(uri) ?? []
                pending.push(message)
                this.openingDocuments.set(uri, pending)
                // Compile arguments can depend on the source's judge mode. Send the command before
                // didOpen and preserve subsequent didChange/didClose order while it is being read.
                try {
                    void this.refreshCompileFlags(fileURLToPath(uri)).catch((error) => this.compileError(error))
                } catch (error) {
                    this.openingDocuments.delete(uri)
                    this.compileError(error)
                    this.write(message)
                }
                return
            }
        } else if (m.method === 'textDocument/didClose') {
            this.documents.delete(m.params?.textDocument?.uri)
        }
        const uri = m.params?.textDocument?.uri
        const pending = typeof uri === 'string' ? this.openingDocuments.get(uri) : undefined
        if (pending) {
            pending.push(message)
            return
        }
        this.write(message)
    }

    stop(): Promise<void> {
        // Capture only work that existed before this stop. A new start can await
        // this promise without the stop accidentally waiting for that new start.
        const starting = this.starting,
            previousStop = this.stoppingTask
        this.probeAbort?.abort()
        this.probeAbort = undefined
        this.stopping = true
        ++this.generation
        this.starting = undefined
        clearTimeout(this.retryTimer)
        this.retryTimer = undefined
        this.documents.clear()
        this.openingDocuments.clear()
        this.compileRevisions.clear()
        this.compileCommands.clear()
        this.compileTasks.clear()
        const formatting = this.formatting
        this.formatting = new FormattingDocuments()
        formatting.cancel()
        const cleanupFormats = Promise.allSettled([...this.formatTasks])
            .then(() => formatting.dispose())
            .catch(() => {})
        const child = this.child
        this.child = undefined
        let task!: Promise<void>
        task = (async () => {
            try {
                await Promise.all([previousStop, starting, cleanupFormats, child ? killTree(child) : undefined])
            } finally {
                if (this.stoppingTask === task) this.stoppingTask = undefined
            }
        })()
        this.stoppingTask = task
        return task
    }

    private spawnServer(generation: number): Promise<boolean> {
        return new Promise((resolve) => {
            if (this.stopping || generation !== this.generation) {
                resolve(false)
                return
            }
            let spawned = false
            const child = spawn(
                this.executable,
                [
                    '--background-index=false',
                    '--header-insertion=never',
                    '--completion-style=detailed',
                    '--completion-parse=always',
                    '--pch-storage=memory',
                    '--limit-results=0',
                    '-j=4',
                    '--fallback-style=LLVM',
                    `--query-driver=${this.resolvedCompiler.replace(/\\/g, '/')}`
                ],
                {
                    cwd: this.root,
                    env: toolchainEnv(),
                    windowsHide: true,
                    detached: process.platform !== 'win32',
                    stdio: 'pipe'
                }
            )
            this.child = child
            this.compileCommands.clear()
            this.compileRevisions.clear()
            this.compileTasks.clear()
            this.openingDocuments.clear()
            const parser = new LspMessageParser((message) => {
                if (this.child !== child) return
                const response = message as RpcMessage
                if (!response.method && response.id !== undefined) {
                    const uri = this.formatting.finish(response.id)
                    if (uri)
                        this.write({
                            jsonrpc: '2.0',
                            method: 'textDocument/didClose',
                            params: { textDocument: { uri } }
                        })
                }
                this.onMessage(message)
            })
            child.stdout.on('data', (chunk: Buffer) => parser.push(chunk))
            child.stderr.on('data', () => {})
            child.stdin.on('error', () => {})
            child.once('spawn', () => {
                spawned = true
                resolve(true)
            })
            child.once('error', () => resolve(false))
            child.once('close', () => {
                if (this.child !== child) return
                this.child = undefined
                const formatting = this.formatting
                this.formatting = new FormattingDocuments()
                void formatting.dispose().catch(() => {})
                if (this.stopping || generation !== this.generation) return
                if (!spawned || this.restarts >= 3) {
                    this.emitStatus('fallback')
                    return
                }
                const delay = 200 * 2 ** this.restarts++
                this.emitStatus('starting')
                this.retryTimer = setTimeout(() => {
                    if (generation !== this.generation || this.stopping) return
                    void this.spawnServer(generation).then(
                        (ok) => {
                            if (generation === this.generation && !this.stopping)
                                this.emitStatus(ok ? 'restarted' : 'fallback')
                        },
                        () => {
                            if (generation === this.generation && !this.stopping) this.emitStatus('fallback')
                        }
                    )
                }, delay)
            })
        })
    }

    private emitStatus(state: 'starting' | 'restarted' | 'fallback'): void {
        this.onMessage({ jsonrpc: '2.0', method: '$/iter/status', params: { state } })
    }

    private async format(message: RpcMessage): Promise<void> {
        const id = message.id!,
            generation = this.generation,
            child = this.child,
            formatting = this.formatting
        this.preparingFormats.add(id)
        try {
            const settings = this.getFormatSettings()
            const document = await formatting.prepare(id, message.params.textDocument.uri, settings)
            if (!child || child !== this.child || generation !== this.generation || this.cancelledFormats.has(id)) {
                formatting.finish(id)
                return
            }
            const { iterSource: code, ...params } = message.params
            if (document.temporary)
                this.write({
                    jsonrpc: '2.0',
                    method: 'textDocument/didOpen',
                    params: { textDocument: { uri: document.uri, languageId: 'cpp', version: 1, text: code } }
                })
            this.write({
                ...message,
                params: {
                    ...params,
                    options: { ...params.options, ...indentationSettings(settings.editor) },
                    textDocument: { uri: document.uri }
                }
            })
        } catch (error) {
            formatting.finish(id)
            if (generation === this.generation)
                this.onMessage({
                    jsonrpc: '2.0',
                    id,
                    error: { code: -32603, message: `Formatting failed: ${(error as Error).message}` }
                })
        } finally {
            this.preparingFormats.delete(id)
            this.cancelledFormats.delete(id)
        }
    }

    /** IPC owner: call this after changing a source's judge mode/configuration. */
    refreshCompileFlags(sourcePath: string): Promise<void> {
        const file = path.resolve(sourcePath),
            child = this.child,
            generation = this.generation
        const uri = pathToFileURL(file).href
        const revision = (this.compileRevisions.get(file) ?? 0) + 1
        this.compileRevisions.set(file, revision)
        const flags = this.flags,
            compiler = this.resolvedCompiler
        if (this.documents.has(uri) && !this.openingDocuments.has(uri)) this.openingDocuments.set(uri, [])
        const task = (async () => {
            const args = await compileArgsFor(file, flags)
            const { cwd: workingDirectory } = sourceCompileContext(file, args)
            if (
                !child ||
                child !== this.child ||
                generation !== this.generation ||
                this.compileRevisions.get(file) !== revision
            )
                return
            const command = {
                workingDirectory,
                compilationCommand: [compiler, '-x', 'c++', ...this.driverFlags, ...args, file]
            }
            const serialized = JSON.stringify(command)
            if (this.compileCommands.get(file) === serialized) return
            this.compileCommands.set(file, serialized)
            this.write({
                jsonrpc: '2.0',
                method: 'workspace/didChangeConfiguration',
                params: { settings: { compilationDatabaseChanges: { [file]: command } } }
            })
        })().finally(() => {
            if (this.compileTasks.get(file) !== task) return
            this.compileTasks.delete(file)
            const queued = this.openingDocuments.get(uri)
            this.openingDocuments.delete(uri)
            if (child === this.child && generation === this.generation)
                for (const message of queued ?? []) this.write(message)
        })
        this.compileTasks.set(file, task)
        return task
    }

    private compileError(error: unknown): void {
        this.onMessage({
            jsonrpc: '2.0',
            method: 'window/logMessage',
            params: { type: 1, message: `Cannot refresh clangd compile arguments: ${String(error)}` }
        })
    }

    private write(message: unknown): void {
        if (!this.child?.stdin.writable) return
        try {
            this.child.stdin.write(frameMessage(message))
        } catch {
            /* close handles a concurrent exit */
        }
    }
}
