import { promises as fs } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { StringDecoder } from 'node:string_decoder'
import type { BreakpointInfo, DebugRecordingOptions, DebugResourceLimit } from '../../shared/debug'
import type { ToolchainSettings } from '../../shared/judge'
import { resolveTool } from '../toolchain'
import type { DebugBuild } from './build'
import { MIClient } from './mi-client'
import { miList, miQuote, miString, miTuple, type MIRecord, type MITuple } from './mi'
import { enablePrettyPrinters } from './pretty-printers'
import { runProcess } from './process'
import { recorderPython } from './recorder'
import { sameFile, type RecordResult, type Snapshot, type TraceFrame, type ValueNode } from './trace'
import { ValueSummaries } from './value-summary'
import { TraceOutput } from './output'
import { DebugLimitError, MAX_TRACE_BYTES, MAX_TRACE_NODES, TraceBudget } from './budget'
import { OutputTailer } from './output-tailer'
import { isReadOnlyDebugExpression } from '../../shared/debugExpression'

interface WireNode extends Omit<ValueNode, 'children'> {
    children?: number[]
}
interface WireSnapshot extends Omit<Snapshot, 'frames' | 'globals'> {
    frames: (Omit<TraceFrame, 'locals'> & { locals: number[] })[]
    globals: number[]
    definitions: { id: number; node: WireNode }[]
}
export class NativeDebugger {
    readonly client: MIClient
    readonly options: Required<DebugRecordingOptions>
    python = false
    private snapshots: Snapshot[] = []
    private nativeIndex?: number
    private readonly queryPath: string
    private readonly interruptPath: string
    private disposed = false
    private disposing?: Promise<void>
    private interrupting?: Promise<void>
    private requestedPause = false
    recordedOutput = new TraceOutput()
    private recording = false
    private startBreakpoints: BreakpointInfo[] = []
    private source = ''
    private seeker?: Promise<NativeDebugger>
    private readonly queries = new Set<Promise<unknown>>()
    private readonly nodes = new Map<number, ValueNode>()
    readonly timings: Record<string, number> = {}
    resourceLimit?: DebugResourceLimit
    private readonly traceBudget: TraceBudget
    private stoppingForLimit?: Promise<void>
    private get outputLimit(): number {
        return Number.isFinite(this.tools.outputLimitBytes)
            ? Math.max(1, this.tools.outputLimitBytes)
            : 64 * 1024 * 1024
    }
    private async outputSizes(): Promise<number> {
        return (
            await Promise.all(
                [this.build.stdoutPath, this.build.stderrPath, this.build.fileOutput].map(async (file) =>
                    file ? ((await fs.stat(file).catch(() => undefined))?.size ?? 0) : 0
                )
            )
        ).reduce((a, b) => a + b, 0)
    }
    private watchOutput(): () => void {
        let active = true,
            checking = false
        const timer = setInterval(() => {
            if (checking || this.resourceLimit || this.disposed) return
            checking = true
            void this.outputSizes()
                .then(async (size) => {
                    if (active && !this.disposed && size > this.outputLimit) {
                        this.resourceLimit = 'output'
                        await this.interrupt()
                    }
                })
                .catch(() => {})
                .finally(() => {
                    checking = false
                })
        }, 50)
        timer.unref()
        return () => {
            active = false
            clearInterval(timer)
        }
    }
    private stopForLimit(): Promise<void> {
        return (this.stoppingForLimit ??= (async () => {
            try {
                await this.console('kill', 5000)
            } catch {
                await this.client.dispose()
            }
        })())
    }
    private asLimit(error: unknown): DebugLimitError | undefined {
        if (error instanceof DebugLimitError) return error
        const match = /Debug resource limit: (output|trace|nodes)/.exec(String(error))
        return match ? new DebugLimitError(match[1] as DebugResourceLimit) : undefined
    }
    private decode(wire: WireSnapshot): Snapshot {
        this.traceBudget.accept(Buffer.byteLength(JSON.stringify(wire)) + 1, wire.definitions.length)
        const { definitions, ...snapshot } = wire
        const get = (id: number): ValueNode => {
            const node = this.nodes.get(id)
            if (!node) throw new Error('调试记录引用了缺失的数据')
            return node
        }
        for (const { id, node } of definitions) this.nodes.set(id, { ...node, children: node.children?.map(get) })
        return {
            ...snapshot,
            file: snapshot.file ?? undefined,
            line: snapshot.line ?? undefined,
            signal: snapshot.signal ?? undefined,
            breakpointError: snapshot.breakpointError ?? undefined,
            frames: wire.frames.map((frame) => ({
                ...frame,
                file: frame.file ?? undefined,
                line: frame.line ?? undefined,
                locals: frame.locals.map(get)
            })),
            globals: wire.globals.map(get)
        }
    }
    private operations: Promise<unknown> = Promise.resolve()
    private pendingOperations = 0
    private operation<T>(work: () => Promise<T>): Promise<T> {
        if (this.disposed) return Promise.reject(new Error('调试已停止'))
        if (this.pendingOperations >= 64) return Promise.reject(new Error('调试请求过多，请稍后重试'))
        ++this.pendingOperations
        const next = this.operations
            .then(async () => {
                if (this.disposed) throw new Error('调试已停止')
                if (this.resourceLimit) throw new DebugLimitError(this.resourceLimit)
                const stop = this.watchOutput()
                try {
                    const result = await work()
                    if (this.resourceLimit) throw new DebugLimitError(this.resourceLimit)
                    return result
                } catch (error) {
                    const limit = this.asLimit(error)
                    if (limit) this.resourceLimit = limit.limit
                    throw limit ?? error
                } finally {
                    stop()
                    if (this.resourceLimit) await this.stopForLimit()
                }
            })
            .finally(() => {
                --this.pendingOperations
            })
        this.operations = next.catch(() => {})
        return next
    }
    private readonly summaries: ValueSummaries
    constructor(
        readonly build: DebugBuild,
        private readonly tools: ToolchainSettings,
        options: DebugRecordingOptions | undefined,
        progress: (steps: number) => void,
        fatal: (error: Error) => void
    ) {
        const bound = (value: number | undefined, fallback: number, min: number, max: number): number =>
            Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value!))) : fallback
        this.options = {
            maxSteps: bound(options?.maxSteps, 20_000, 1, 200_000),
            maxDurationMs: bound(options?.maxDurationMs, 30_000, 50, 600_000),
            maxChildren: bound(options?.maxChildren, 200, 1, 10_000),
            maxDepth: bound(options?.maxDepth, 3, 1, 10),
            maxNodes: bound(options?.maxNodes, 2000, 10, 100_000),
            maxTraceBytes: bound(options?.maxTraceBytes, MAX_TRACE_BYTES, 1, MAX_TRACE_BYTES),
            maxTotalNodes: bound(options?.maxTotalNodes, MAX_TRACE_NODES, 1, MAX_TRACE_NODES)
        }
        this.traceBudget = new TraceBudget(this.options.maxTraceBytes, this.options.maxTotalNodes)
        this.queryPath = path.join(build.dir, 'query.json')
        this.interruptPath = path.join(build.dir, 'interrupt.flag')
        this.client = new MIClient(resolveTool('gdb', tools).command, build.cwd)
        this.summaries = new ValueSummaries((cmd) => this.client.command(cmd))
        this.client.on('closed', (error) => {
            if (!this.disposed && !this.resourceLimit) fatal(error)
        })
        this.client.on('record', (record: MIRecord) => {
            if (record.kind === 'console') {
                for (const match of record.text.matchAll(/ITER_PROGRESS:(\d+)/g)) progress(Number(match[1]))
            }
        })
    }
    console(command: string, timeout = 30_000): Promise<MITuple> {
        return this.client.command(`-interpreter-exec console ${miQuote(command)}`, timeout)
    }
    private serial = 0
    /** GDB emits ^running for a Python command's first nested run, BEFORE the
     * Python command completes. Its own completion marker is the synchronization. */
    private async pythonCommand(code: string, timeout = 30_000): Promise<void> {
        const marker = `ITER_DONE_${++this.serial}:`
        let finish!: (error?: Error) => void
        const done = new Promise<void>((resolve, reject) => {
            finish = (error) => (error ? reject(error) : resolve())
        })
        const listener = (r: MIRecord): void => {
            if (r.kind !== 'console' || !r.text.includes(marker)) return
            try {
                const data: unknown = JSON.parse(r.text.slice(r.text.indexOf(marker) + marker.length).trim())
                if (
                    !data ||
                    typeof data !== 'object' ||
                    Array.isArray(data) ||
                    ('error' in data && typeof data.error !== 'string')
                )
                    throw new Error('无效的 GDB 完成响应')
                finish('error' in data ? new Error(data.error as string) : undefined)
            } catch {
                finish(new Error('无效的 GDB 完成响应'))
            }
        }
        this.client.on('record', listener)
        const closed = (error: Error): void => finish(error)
        this.client.on('closed', closed)
        const timer = setTimeout(() => {
            void this.interrupt().catch(() => {})
            finish(new Error('GDB 精确操作超时'))
        }, timeout)
        const script = `try:\n ${code.replace(/\n/g, '\n ')}\nexcept BaseException as e:\n gdb.write(${JSON.stringify(marker)} + json.dumps(dict(error=str(e))) + '\\n')\nelse:\n gdb.write(${JSON.stringify(marker)} + '{}\\n')`
        try {
            // Attach the rejection handler before sending, including synchronous ^error.
            await Promise.all([this.console(`python exec(${JSON.stringify(script)})`, timeout), done])
        } finally {
            clearTimeout(timer)
            this.client.off('record', listener)
            this.client.off('closed', closed)
        }
    }
    async initialize(source: string): Promise<void> {
        this.source = source
        let start = performance.now()
        const b = this.build
        await this.client.batch([
            '-gdb-set pagination off',
            '-gdb-set confirm off',
            '-gdb-set print elements 201',
            '-gdb-set print repeats 0',
            '-gdb-set print thread-events off',
            '-gdb-set mi-async on',
            `-environment-cd ${miQuote(b.cwd)}`,
            `-file-exec-and-symbols ${miQuote(b.exe)}`,
            ...[
                ['ITER_STDIN', b.inputPath],
                ['ITER_STDOUT', b.stdoutPath],
                ['ITER_STDERR', b.stderrPath]
            ].map(([name, value]) => `-gdb-set environment ${name}=${value}`)
        ])
        this.timings.startupAndSymbols = performance.now() - start
        start = performance.now()
        await enablePrettyPrinters(
            this.client,
            resolveTool('compiler', this.tools).command,
            resolveTool('gdb', this.tools).command
        )
        this.timings.printers = performance.now() - start
        start = performance.now()
        try {
            await this.console('python import gdb')
            this.python = true
        } catch {
            return
        }
        const script = path.join(b.dir, 'recorder.py')
        await fs.writeFile(script, recorderPython)
        await this.console(`source ${script.replace(/\\/g, '/')}`)
        const config = {
            ...b,
            ...this.options,
            outputLimitBytes: this.outputLimit,
            sourceDir: path.dirname(b.sourcePath),
            identifiers: [...new Set(source.match(/[a-zA-Z_]\w*(?:::\w+)*/g) ?? [])],
            tracePath: path.join(b.dir, 'trace.jsonl'),
            metaPath: path.join(b.dir, 'meta.json'),
            queryPath: this.queryPath,
            interruptPath: this.interruptPath
        }
        await this.console(`python iter_init(${JSON.stringify(JSON.stringify(config))})`)
        this.timings.script = performance.now() - start
    }
    async record(
        append: (snapshots: Snapshot[]) => void = () => {},
        startBreakpoints: BreakpointInfo[] = [],
        begun: () => void = () => {}
    ): Promise<RecordResult> {
        let started = performance.now()
        const stopOutputWatch = this.watchOutput()
        this.startBreakpoints = startBreakpoints.map((bp) => ({ ...bp }))
        this.recording = true
        try {
            // Run normally up to the requested starting stop. Preprocessing does not
            // consume trace steps or the recording wall clock, and remains cancellable.
            if (this.python)
                await this.pythonCommand(
                    `iter_trace.begin(json.loads(${JSON.stringify(JSON.stringify(this.startBreakpoints))}))`,
                    600_000
                )
            started = performance.now()
            begun()
            return await this.recordWithinBudget(append, started)
        } catch (error) {
            const limit = this.asLimit(error)
            if (!limit && !this.resourceLimit) throw error
            this.resourceLimit ??= limit!.limit
            return {
                snapshots: this.snapshots,
                ended: true,
                limited: this.resourceLimit,
                elapsedMs: performance.now() - started
            }
        } finally {
            this.recording = false
            stopOutputWatch()
            if (this.resourceLimit) await this.stopForLimit()
        }
    }
    private async recordWithinBudget(append: (snapshots: Snapshot[]) => void, started: number): Promise<RecordResult> {
        if (!this.python) {
            await this.client.command('-break-insert -t main')
            await this.miMove('-exec-run')
            if (this.resourceLimit)
                return {
                    snapshots: [],
                    ended: true,
                    limited: this.resourceLimit,
                    elapsedMs: performance.now() - started
                }
            this.snapshots = [await this.miCapture(0, 'entry')]
            this.nativeIndex = 0
            const io = await this.output()
            this.snapshots[0].outputChanges = Object.fromEntries(
                Object.entries(io).map(([key, data]) => [key, { reset: true, data: data.toString('base64') }])
            )
            this.chargeSnapshot(this.snapshots[0])
            this.recordedOutput.add(this.snapshots[0])
            append(this.snapshots)
            return { snapshots: this.snapshots, ended: false, limited: 'python-unavailable', elapsedMs: 0 }
        }
        const tracePath = path.join(this.build.dir, 'trace.jsonl')
        await fs.writeFile(tracePath, '')
        const file = await fs.open(tracePath, 'r')
        const decoder = new StringDecoder('utf8')
        let position = 0,
            pending = '',
            tail: Promise<void> = Promise.resolve(),
            tailError: unknown,
            draining = false
        const drain = async (): Promise<void> => {
            if (this.resourceLimit) return
            const buffer = Buffer.alloc(256 * 1024)
            for (;;) {
                const { bytesRead } = await file.read(buffer, 0, buffer.length, position)
                if (!bytesRead) break
                const batch: Snapshot[] = []
                position += bytesRead
                pending += decoder.write(buffer.subarray(0, bytesRead))
                let newline: number
                while ((newline = pending.indexOf('\n')) >= 0) {
                    const snapshot = this.decode(JSON.parse(pending.slice(0, newline)) as WireSnapshot)
                    pending = pending.slice(newline + 1)
                    this.snapshots.push(snapshot)
                    this.recordedOutput.add(snapshot)
                    batch.push(snapshot)
                }
                if (batch.length && !this.disposed) append(batch)
            }
        }
        const poll = (): void => {
            // One reader owns the decoder/cursor; slow IO cannot build a poll queue.
            if (draining || this.disposed || tailError) return
            draining = true
            tail = drain()
                .catch((error) => {
                    const limit = this.asLimit(error)
                    if (limit) {
                        this.resourceLimit = limit.limit
                        void this.interrupt().catch(() => {})
                    } else tailError = error
                })
                .finally(() => {
                    draining = false
                })
        }
        const timer = setInterval(poll, 10)
        const watchdog = setTimeout(() => {
            void this.interrupt().catch(() => {})
        }, this.options.maxDurationMs + 100)
        try {
            try {
                await this.pythonCommand('iter_trace.record()', this.options.maxDurationMs + 30_000)
            } catch (error) {
                const limit = this.asLimit(error)
                if (!limit && !this.resourceLimit) throw error
                this.resourceLimit ??= limit!.limit
            }
            // Stop scheduling reads before the final drain; all drains share the
            // decoder and byte cursor and must never overlap.
            clearInterval(timer)
            await tail
            try {
                await drain()
            } catch (error) {
                const limit = this.asLimit(error)
                if (!limit) throw error
                this.resourceLimit = limit.limit
            }
            if (tailError) throw tailError
            if (pending && !this.resourceLimit) throw new Error('调试记录末尾不完整')
        } finally {
            clearInterval(timer)
            clearTimeout(watchdog)
            // An already-fired watchdog can still be writing the interrupt flag or
            // invoking the Windows helper. Join it before allowing a live movement.
            await this.interrupting
            await tail
            await file.close()
        }
        const meta = JSON.parse(await fs.readFile(path.join(this.build.dir, 'meta.json'), 'utf8')) as Omit<
            RecordResult,
            'snapshots'
        >
        if (meta.limited && ['output', 'trace', 'nodes'].includes(meta.limited))
            this.resourceLimit = meta.limited as DebugResourceLimit
        this.nativeIndex = this.snapshots.length - 1
        return {
            snapshots: this.snapshots,
            ...meta,
            ended: !!this.resourceLimit || meta.ended,
            limited: this.resourceLimit ?? meta.limited ?? undefined
        }
    }
    async output(): Promise<{ stdout: Buffer; stderr: Buffer; file: Buffer }> {
        if ((await this.outputSizes()) > this.outputLimit) throw new DebugLimitError('output')
        const read = async (file?: string): Promise<Buffer> => {
            if (!file) return Buffer.alloc(0)
            const handle = await fs.open(file, 'r').catch(() => undefined)
            if (!handle) return Buffer.alloc(0)
            try {
                const parts: Buffer[] = []
                let length = 0
                for (;;) {
                    const buffer = Buffer.alloc(Math.min(64 * 1024, this.outputLimit + 1 - length))
                    const { bytesRead } = await handle.read(buffer, 0, buffer.length, length)
                    if (!bytesRead) break
                    length += bytesRead
                    if (length > this.outputLimit) throw new DebugLimitError('output')
                    parts.push(buffer.subarray(0, bytesRead))
                }
                return Buffer.concat(parts)
            } finally {
                await handle.close()
            }
        }
        const [stdout, stderr, file] = await Promise.all([
            read(this.build.stdoutPath),
            read(this.build.stderrPath),
            read(this.build.fileOutput)
        ])
        if (stdout.length + stderr.length + file.length > this.outputLimit) throw new DebugLimitError('output')
        return { stdout, stderr, file }
    }
    outputTailer(): OutputTailer {
        return new OutputTailer(
            { stdout: this.build.stdoutPath, stderr: this.build.stderrPath, file: this.build.fileOutput },
            this.outputLimit,
            this.tools.displayLimitChars
        )
    }
    private chargeSnapshot(snapshot: Snapshot): void {
        const nodes = new Set<ValueNode>()
        const visit = (node: ValueNode): void => {
            if (nodes.has(node)) return
            nodes.add(node)
            for (const child of node.children ?? []) visit(child)
        }
        for (const frame of snapshot.frames) for (const node of frame.locals) visit(node)
        for (const node of snapshot.globals) visit(node)
        this.traceBudget.accept(Buffer.byteLength(JSON.stringify(snapshot)) + 1, nodes.size)
    }
    private chargeQuery(node: ValueNode): ValueNode {
        const nodes = new Set<ValueNode>()
        const visit = (item: ValueNode): void => {
            if (nodes.has(item)) return
            nodes.add(item)
            for (const child of item.children ?? []) visit(child)
        }
        visit(node)
        try {
            this.traceBudget.accept(Buffer.byteLength(JSON.stringify(node)), nodes.size)
        } catch (error) {
            if (error instanceof DebugLimitError) {
                this.resourceLimit = error.limit
                void this.interrupt().catch(() => {})
            }
            throw error
        }
        return node
    }
    private readonly locations = new Map<string, number | null>()
    resolveLine(file: string, line: number): Promise<number | null> {
        if (this.recording)
            return this.operation(() => this.exactSeeker().then((seeker) => seeker.resolveLine(file, line)))
        return this.operation(async () => {
            const key = `${file}:${line}`
            if (this.locations.has(key)) return this.locations.get(key)!
            let resolved: number | null = null
            try {
                const result = await this.client.command(
                    `-break-insert -d ${miQuote(file.replace(/\\/g, '/') + ':' + line)}`
                )
                const bp = miTuple(result.bkpt),
                    id = miString(bp.number)
                const location = miList(bp.locations)
                    .map(miTuple)
                    .find((item) => sameFile(miString(item.fullname), file))
                resolved = Number(miString(bp.line)) || Number(miString(location?.line)) || null
                if (id) await this.client.command(`-break-delete ${id}`)
            } catch {
                /* no code/symbol for this requested source location */
            }
            this.locations.set(key, resolved)
            return resolved
        })
    }
    async seek(index: number): Promise<void> {
        if (this.disposed) throw new Error('调试已停止')
        if (this.nativeIndex === index) return
        await fs.rm(this.interruptPath, { force: true })
        if (this.python) await this.pythonCommand(`iter_trace.seek(${index})`, 60_000)
        else {
            await this.console('kill').catch(() => {})
            await this.client.command('-break-delete').catch(() => {})
            await this.client.command('-break-insert -t main')
            await this.miMove('-exec-run')
            for (let i = 0; i <= index; i++) {
                const snapshot = await this.miCapture(i)
                if (
                    snapshot.signature !== this.snapshots[i].signature ||
                    snapshot.fingerprint !== this.snapshots[i].fingerprint
                )
                    throw new Error('精确定位失败：程序执行与记录不一致')
                if (i < index) await this.miStep('step')
            }
        }
        const actual = await this.output(),
            expected = this.recordedOutput.buffers(index)
        if (
            !actual.stdout.equals(expected.stdout) ||
            !actual.stderr.equals(expected.stderr) ||
            !actual.file.equals(expected.file)
        ) {
            if (this.python) await this.console('python iter_trace.native_index = None')
            this.nativeIndex = undefined
            throw new Error('精确定位失败：程序输出与记录不一致')
        }
        this.nativeIndex = index
    }
    query(
        index: number,
        frame: number,
        expression: string,
        childPath: number[] = [],
        readOnly = false
    ): Promise<ValueNode> {
        if (this.disposed) return Promise.reject(new Error('调试已停止'))
        if (readOnly && !isReadOnlyDebugExpression(expression))
            return Promise.reject(new Error('自动检查仅支持只读表达式'))
        if (this.resourceLimit) return Promise.reject(new DebugLimitError(this.resourceLimit))
        if (this.queries.size >= 64) return Promise.reject(new Error('调试查询过多，请稍后重试'))
        const work = (async () => {
            const seeker = await this.exactSeeker()
            const node = await seeker.operation(async () => {
                // Keep the recording/live inferior at its frontier, even after a cap.
                // Inspection must never restart it at a timing-dependent snapshot.
                seeker.snapshots = this.snapshots.slice()
                seeker.recordedOutput = this.recordedOutput
                if (seeker.python) {
                    const positions = path.join(seeker.build.dir, 'positions.json')
                    await fs.writeFile(
                        positions,
                        JSON.stringify(
                            seeker.snapshots.map(({ signature, fingerprint, file, line, movement, breakpoints }) => ({
                                signature,
                                fingerprint,
                                file,
                                line,
                                movement,
                                breakpoints
                            }))
                        )
                    )
                    await seeker.console(`python iter_trace.positions = json.load(open(${JSON.stringify(positions)}))`)
                }
                return seeker.queryAt(index, frame, expression, childPath, readOnly)
            })
            if (this.disposed) throw new Error('调试已停止')
            return this.chargeQuery(node)
        })().finally(async () => {
            this.queries.delete(work)
            if (this.resourceLimit) await this.stopForLimit()
        })
        this.queries.add(work)
        return work
    }
    private exactSeeker(): Promise<NativeDebugger> {
        if (this.disposed) return Promise.reject(new Error('调试已停止'))
        return (this.seeker ??= (async () => {
            const b = this.build,
                dir = path.join(b.dir, 'seeker'),
                cwd = path.join(dir, 'run')
            await fs.mkdir(cwd, { recursive: true })
            const isolate = (file?: string): string | undefined =>
                file ? path.join(cwd, path.relative(b.cwd, file)) : undefined
            const build = {
                ...b,
                dir,
                cwd,
                stdoutPath: path.join(dir, 'stdout.txt'),
                stderrPath: path.join(dir, 'stderr.txt'),
                fileInput: isolate(b.fileInput),
                fileOutput: isolate(b.fileOutput)
            }
            for (const file of [build.fileInput, build.fileOutput])
                if (file) await fs.mkdir(path.dirname(file), { recursive: true })
            const seeker = new NativeDebugger(
                build,
                this.tools,
                this.options,
                () => {},
                () => {}
            )
            try {
                await seeker.initialize(this.source)
                seeker.startBreakpoints = this.startBreakpoints
                if (seeker.python)
                    await seeker.console(
                        `python iter_trace.start_specs = json.loads(${JSON.stringify(JSON.stringify(this.startBreakpoints))})`
                    )
                if (this.disposed) throw new Error('调试已停止')
                return seeker
            } catch (error) {
                await seeker.dispose()
                throw error
            }
        })())
    }
    private async queryAt(
        index: number,
        frame: number,
        expression: string,
        childPath: number[],
        readOnly = false
    ): Promise<ValueNode> {
        await this.seek(index)
        if (!readOnly) return this.evaluateAt(frame, expression, childPath)
        const current = await this.client.command('-gdb-show may-call-functions')
        await this.client.command('-gdb-set may-call-functions off')
        try {
            return await this.evaluateAt(frame, expression, childPath)
        } finally {
            await this.client.command(`-gdb-set may-call-functions ${miString(current.value) === 'off' ? 'off' : 'on'}`)
        }
    }
    private async evaluateAt(frame: number, expression: string, childPath: number[]): Promise<ValueNode> {
        if (this.python) {
            try {
                await this.pythonCommand(
                    `iter_trace.query(json.loads(${JSON.stringify(JSON.stringify({ frame, expression, path: childPath }))}))`
                )
                return JSON.parse(await fs.readFile(this.queryPath, 'utf8')) as ValueNode
            } finally {
                this.nativeIndex = undefined
            }
        }
        try {
            await this.client.command(`-stack-select-frame ${frame}`)
            let result = await this.client.command(`-var-create - * ${miQuote(expression)}`)
            for (const index of childPath) {
                const children = await this.client.command(
                    `-var-list-children --all-values ${miQuote(miString(result.name))} ${index} ${index + 1}`
                )
                const child = miList(children.children)[0]
                if (!child) throw new Error('该子项不存在')
                result = miTuple(miTuple(child).child)
            }
            return await this.miNode(result, expression, expression, childPath, 0, { remaining: this.options.maxNodes })
        } finally {
            this.nativeIndex = undefined
        }
    }
    advance(
        index: number,
        command: 'step' | 'next' | 'finish' | 'continue',
        bps: BreakpointInfo[],
        ready?: () => void
    ): Promise<Snapshot> {
        return this.operation(() => this.advanceAt(index, command, bps, ready))
    }
    private async advanceAt(
        index: number,
        command: 'step' | 'next' | 'finish' | 'continue',
        bps: BreakpointInfo[],
        ready?: () => void
    ): Promise<Snapshot> {
        await this.seek(index - 1)
        this.nativeIndex = undefined
        this.requestedPause = false
        await fs.rm(this.interruptPath, { force: true })
        ready?.()
        if (!this.python) await this.client.command('-break-delete').catch(() => {})
        if (!this.python && command === 'continue')
            for (const bp of bps.filter((b) => b.enabled && b.verified)) {
                const result = await this.client.command(
                    `-break-insert ${miQuote(bp.file.replace(/\\/g, '/') + ':' + bp.line)}`
                )
                const id = miString(miTuple(result.bkpt).number)
                if (bp.condition)
                    await this.client.command(`-break-condition ${id} ${miQuote(bp.condition)}`).catch(() => {})
                if (bp.hitCondition && bp.hitCondition > 1)
                    await this.client.command(`-break-after ${id} ${Math.max(0, bp.hitCondition - bp.hits - 1)}`)
            }
        let snapshot: Snapshot
        if (this.python) {
            await this.pythonCommand(
                `iter_trace.advance(${JSON.stringify(command)}, ${index}, json.loads(${JSON.stringify(JSON.stringify(bps))}))`,
                600_000
            )
            snapshot = this.decode(JSON.parse(await fs.readFile(this.queryPath, 'utf8')) as WireSnapshot)
        } else {
            await this.miStep(command)
            snapshot = await this.miCapture(index)
            const io = await this.output()
            snapshot.outputChanges = Object.fromEntries(
                Object.entries(io).map(([key, data]) => [key, { reset: true, data: data.toString('base64') }])
            )
            this.chargeSnapshot(snapshot)
        }
        if (this.requestedPause && (!snapshot.signal || ['SIGTRAP', 'SIGINT'].includes(snapshot.signal))) {
            snapshot.signal = undefined
            snapshot.reason = 'pause'
        }
        this.snapshots[index] = snapshot
        this.recordedOutput.add(snapshot)
        this.nativeIndex = index
        return snapshot
    }
    interrupt(): Promise<void> {
        if (this.disposed) return Promise.resolve()
        this.requestedPause = true
        return (this.interrupting ??= (async () => {
            // Python's nested finish can report a generic StopEvent for the Windows
            // break thread. A file flag identifies our pause even in that GDB version.
            await fs.writeFile(this.interruptPath, '')
            if (process.platform === 'win32' && this.build.interruptExe) {
                await Promise.all(
                    this.client.inferiorPids.map((pid) =>
                        runProcess(this.build.interruptExe!, [String(pid)], { timeout: 5000 })
                    )
                )
            } else this.client.interrupt()
        })().finally(() => {
            this.interrupting = undefined
        }))
    }
    private miStopped?: MITuple
    private async miMove(command: string): Promise<void> {
        let receive!: (result: MITuple) => void
        let fail!: (error: Error) => void
        const stopped = new Promise<MITuple>((resolve, reject) => {
            receive = resolve
            fail = reject
        })
        const listener = (r: MIRecord): void => {
            if (r.kind === 'exec' && r.cls === 'stopped') receive(r.results)
        }
        this.client.on('record', listener)
        this.client.on('closed', fail)
        try {
            await Promise.all([
                this.client.command(command),
                stopped.then((result) => {
                    this.miStopped = result
                })
            ])
        } finally {
            this.client.off('record', listener)
            this.client.off('closed', fail)
        }
    }
    private async miNode(
        tuple: MITuple,
        name: string,
        expression: string,
        childPath: number[],
        depth: number,
        budget: { remaining: number }
    ): Promise<ValueNode> {
        const node: ValueNode = {
            ...(await this.summaries.variable(tuple, name, expression)),
            selector: { expression, path: childPath }
        }
        if (!node.hasChildren) return node
        if (depth >= this.options.maxDepth || budget.remaining-- <= 0) {
            node.truncated = true
            return node
        }
        const result = await this.client.command(
            `-var-list-children --all-values ${miQuote(miString(tuple.name))} 0 ${this.options.maxChildren}`
        )
        node.children = []
        for (const [i, child] of miList(result.children).entries()) {
            if (budget.remaining-- <= 0) break
            const item = miTuple(miTuple(child).child)
            node.children.push(
                await this.miNode(item, miString(item.exp), expression, [...childPath, i], depth + 1, budget)
            )
        }
        node.truncated = miString(result.has_more) === '1' || Number(miString(tuple.numchild)) > node.children.length
        return node
    }
    private async miStep(command: string): Promise<void> {
        await this.miMove(`-exec-${command}`)
        for (let i = 0; i < 128; i++) {
            const frame = miTuple(this.miStopped?.frame)
            if (
                sameFile(miString(frame.fullname), this.build.sourcePath) ||
                miString(this.miStopped?.reason).startsWith('exited') ||
                this.miStopped?.['signal-name']
            )
                return
            await this.miMove('-exec-finish')
        }
        throw new Error('无法返回用户代码')
    }
    private async miCapture(index: number, reason: Snapshot['reason'] = 'step'): Promise<Snapshot> {
        const exited = miString(this.miStopped?.reason).startsWith('exited')
        const frames = exited
            ? []
            : miList((await this.client.command('-stack-list-frames')).stack).map((item) => {
                  const f = miTuple(miTuple(item).frame)
                  return {
                      level: Number(miString(f.level)),
                      func: miString(f.func),
                      file: miString(f.fullname) || undefined,
                      line: Number(miString(f.line)) || undefined,
                      locals: [] as ValueNode[]
                  }
              })
        this.summaries.clear()
        for (const frame of frames.filter((f) => sameFile(f.file, this.build.sourcePath))) {
            await this.client.command(`-stack-select-frame ${frame.level}`)
            for (const item of miList((await this.client.command('-stack-list-variables --all-values')).variables)) {
                const v = miTuple(item),
                    name = miString(v.name)
                try {
                    const obj = await this.client.command(`-var-create - * ${miQuote(name)}`)
                    frame.locals.push(await this.miNode(obj, name, name, [], 0, { remaining: this.options.maxNodes }))
                } catch {
                    frame.locals.push({ name, value: miString(v.value) || '<unavailable>', hasChildren: false })
                }
            }
        }
        const output = await this.output(),
            top = frames.find((f) => sameFile(f.file, this.build.sourcePath)) ?? frames[0]
        return {
            index,
            frames,
            globals: [],
            file: top?.file,
            line: top?.line,
            reason: exited ? 'exited' : this.miStopped?.['signal-name'] ? 'signal' : reason,
            signal: miString(this.miStopped?.['signal-name']) || undefined,
            exitCode: exited ? Number.parseInt(miString(this.miStopped?.['exit-code']) || '0', 8) : undefined,
            stdoutOffset: output.stdout.length,
            stderrOffset: output.stderr.length,
            fileOutputOffset: output.file.length,
            signature: JSON.stringify(frames.map((f) => [f.func, f.file, f.line])),
            fingerprint: JSON.stringify(frames.map((f) => f.locals.map((v) => [v.name, v.value])))
        }
    }
    dispose(): Promise<void> {
        this.disposed = true
        return (this.disposing ??= (async () => {
            await Promise.all([
                this.client.dispose(),
                this.seeker?.then(
                    (seeker) => seeker.dispose(),
                    () => {}
                )
            ])
            await this.interrupting?.catch(() => {})
            await Promise.allSettled([this.operations, ...this.queries])
        })())
    }
}
