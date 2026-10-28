import path from 'node:path'
import { performance } from 'node:perf_hooks'
import type {
    Breakpoint,
    BreakpointInfo,
    DebugCommand,
    DebugEvent,
    DebugResourceLimit,
    DebugStartRequest,
    DebugState,
    DebugTraceInfo,
    StackFrame,
    Variable
} from '../../shared/debug'
import type { ToolchainSettings } from '../../shared/judge'
import type { DebugBuild } from './build'
import { evaluateCaptured } from './expression'
import { NativeDebugger } from './native'
import { publicVariable, sameFile, type Snapshot, type ValueNode } from './trace'
import { DebugLimitError, resourceMessage } from './budget'

interface Ref {
    index: number
    frame: number
    node: ValueNode
}
interface EditorBreakpoint {
    requested: number
    info: BreakpointInfo
    matches: Map<number, boolean>
    prefix: number[]
    failureAt?: number
    work?: Promise<void>
}
export class DebugSession {
    private native: NativeDebugger
    private trace: Snapshot[] = []
    private index = 0
    private frame = 0
    private state: DebugState = { status: 'starting' }
    private info: DebugTraceInfo = {
        mode: 'replay',
        totalSteps: 0,
        recordingComplete: false,
        recordingEnded: false,
        recordingMs: 0
    }
    private readonly refs = new Map<string, Ref>()
    private readonly queries = new Map<string, Promise<ValueNode>>()
    private editor: EditorBreakpoint[] = []
    private nextId = 1
    private breakpointRevision = 0
    private breakpointEdit = 0
    private readonly breakpointEdits = new Map<string, number>()
    private disposed = false
    private initialized = false
    private disposing?: Promise<void>
    private busy: Promise<void> = Promise.resolve()
    private pendingMovement?: { command: DebugCommand; promise: Promise<void> }
    private running = false
    private outputTimer?: NodeJS.Timeout
    private epoch = 0
    private navigation = 0
    private version = 0
    private readonly waiters = new Set<() => void>()
    private readonly cancellations = new Set<() => void>()
    private recordingTask?: Promise<void>
    private recordingError?: Error
    constructor(
        private readonly build: DebugBuild,
        private readonly req: DebugStartRequest,
        private readonly tools: ToolchainSettings,
        private readonly emit: (event: DebugEvent) => void
    ) {
        this.native = this.createNative()
        this.replaceBreakpoints(build.sourcePath, req.breakpoints)
    }
    private createNative(): NativeDebugger {
        return new NativeDebugger(
            this.build,
            this.tools,
            this.req.recording,
            () => {},
            (error) => {
                if (!this.disposed) this.failRecording(error)
            }
        )
    }
    private recordingMessage(): string | undefined {
        if (this.info.resourceLimit) return resourceMessage(this.info.resourceLimit)
        if (this.info.recordingError)
            return `自动录制失败：${this.info.recordingError}；已保留 ${this.trace.length} 步，可继续浏览已有记录。`
        const limit = this.info.recordingLimit
        if (!limit) return undefined
        const reason =
            limit === 'time'
                ? `自动录制达到 ${(this.info.recordingLimits?.maxDurationMs ?? 30000) / 1000} 秒上限`
                : limit === 'steps'
                  ? `自动录制达到 ${this.info.recordingLimits?.maxSteps ?? this.trace.length} 步上限`
                  : '当前 GDB 不支持 Python 自动录制'
        return `${reason}；已保留 ${this.trace.length} 步，已有记录可回放，末尾将实时执行。`
    }
    private failRecording(error: unknown): void {
        const failure = error instanceof Error ? error : new Error(String(error))
        if (!this.trace.length) {
            this.recordingError = failure
            this.changed()
            this.publish({ status: 'error', message: failure.message })
            return
        }
        this.recordingError = undefined
        const ended = this.info.recordingComplete && this.info.recordingEnded
        this.info = {
            ...this.info,
            mode: 'replay',
            totalSteps: this.trace.length,
            recordingComplete: true,
            recordingEnded: ended,
            recordingMs: this.info.recordingComplete ? this.info.recordingMs : performance.now() - this.recordingStart,
            recordingError: failure.message,
            final: ended ? this.info.final : undefined
        }
        this.changed()
        if (this.state.status === 'paused') this.publishMetadata()
        else void this.show(Math.min(this.index, this.trace.length - 1), 'pause').catch(() => {})
    }
    private recordingStart = 0
    private publish(state: DebugState): void {
        this.state = state
        if (!this.disposed) this.emit({ type: 'state', state })
    }
    async start(): Promise<void> {
        const epoch = ++this.epoch
        this.initialized = false
        this.trace = []
        this.index = 0
        this.frame = 0
        const { maxSteps = 20000, maxDurationMs = 30000 } = this.native.options ?? {}
        this.info = {
            mode: 'replay',
            totalSteps: 0,
            recordingComplete: false,
            recordingEnded: false,
            recordingMs: 0,
            recordingLimits: { maxSteps, maxDurationMs }
        }
        this.recordingError = undefined
        for (const bp of this.editor) {
            bp.matches.clear()
            bp.prefix = []
            bp.failureAt = undefined
            bp.work = undefined
            bp.info = { ...bp.info, line: bp.requested, hits: 0, verified: true, error: undefined }
        }
        this.recordingStart = performance.now()
        this.publish({ status: 'recording', mode: 'replay', steps: 0 })
        this.emit({ type: 'recording', steps: 0, done: false })
        await this.native.initialize(this.req.source)
        // Editor changes during compiler/GDB startup update the model immediately. Resolve only
        // after initialization, and repeat if that model changed while a symbol query was pending.
        while (this.active(epoch)) {
            const revision = this.breakpointRevision
            await this.verifyBreakpoints()
            if (revision === this.breakpointRevision) break
        }
        if (!this.active(epoch)) return
        this.initialized = true
        this.recordingStart = performance.now()
        let lastProgress = performance.now(),
            lastSteps = 0
        this.recordingTask = this.native
            .record(
                (batch) => {
                    if (!this.active(epoch) || this.info.recordingError) return
                    this.trace.push(...batch)
                    this.info.totalSteps = this.trace.length
                    this.info.recordingMs = performance.now() - this.recordingStart
                    this.changed()
                    if (performance.now() - lastProgress >= 250 || this.trace.length - lastSteps >= 500) {
                        lastProgress = performance.now()
                        lastSteps = this.trace.length
                        this.emit({
                            type: 'recording',
                            steps: this.trace.length,
                            done: false,
                            elapsedMs: this.info.recordingMs
                        })
                        this.publishMetadata()
                    }
                },
                this.req.stopAtEntry
                    ? []
                    : this.editor.filter((bp) => bp.info.enabled && bp.info.verified).map((bp) => ({ ...bp.info })),
                () => {
                    this.recordingStart = performance.now()
                }
            )
            .then(async (result) => {
                if (!this.active(epoch) || this.info.recordingError) return
                if (!this.trace.length)
                    throw new Error(
                        this.native.resourceLimit ? resourceMessage(this.native.resourceLimit) : 'GDB 未产生调试记录'
                    )
                const last = this.trace.at(-1)!
                const resourceLimit =
                    result.limited && ['output', 'trace', 'nodes'].includes(result.limited)
                        ? (result.limited as DebugResourceLimit)
                        : undefined
                this.info = {
                    mode: resourceLimit ? 'replay' : result.limited ? 'live' : 'replay',
                    resourceLimit,
                    totalSteps: this.trace.length,
                    recordingComplete: true,
                    recordingEnded: result.ended,
                    recordingLimit:
                        result.limited && !resourceLimit
                            ? (result.limited as DebugTraceInfo['recordingLimit'])
                            : undefined,
                    recordingLimits: this.info.recordingLimits,
                    recordingMs: result.elapsedMs,
                    final:
                        result.ended && !resourceLimit
                            ? { exitCode: last.exitCode ?? null, signal: last.signal }
                            : undefined
                }
                this.changed()
                this.publishMetadata()
                this.emit({
                    type: 'recording',
                    steps: this.trace.length,
                    done: true,
                    elapsedMs: result.elapsedMs,
                    limited: result.limited
                })
                await this.prepareReplayBreakpoints()
                if (this.active(epoch)) await this.refreshHits()
            })
            .catch((error) => {
                if (!this.active(epoch)) return
                this.failRecording(error)
            })
        try {
            await this.initialStop(epoch, this.navigation)
        } catch (error) {
            if (this.active(epoch)) throw error
        }
    }
    private active(epoch = this.epoch, navigation = this.navigation): boolean {
        return !this.disposed && epoch === this.epoch && navigation === this.navigation
    }
    private changed(): void {
        ++this.version
        for (const wake of this.waiters) wake()
        this.waiters.clear()
    }
    private newNavigation(): number {
        ++this.navigation
        for (const cancel of this.cancellations) cancel()
        this.cancellations.clear()
        this.changed()
        return this.navigation
    }
    private cancellable(work: Promise<void>, navigation: number): Promise<void> {
        if (navigation !== this.navigation || this.disposed) {
            void work.catch(() => {})
            return Promise.resolve()
        }
        let cancel!: () => void
        const cancelled = new Promise<void>((resolve) => {
            cancel = resolve
            this.cancellations.add(cancel)
        })
        // Exact GDB queries may still be cleaning up. Their old navigation result
        // is guarded by its generation; callers need not wait for that cleanup.
        return Promise.race([work, cancelled]).finally(() => this.cancellations.delete(cancel))
    }
    private async wait(epoch: number, navigation: number, version: number): Promise<void> {
        if (!this.active(epoch, navigation)) return
        if (this.recordingError) throw this.recordingError
        if (this.version !== version) return
        await new Promise<void>((resolve) => this.waiters.add(resolve))
        if (this.recordingError && this.active(epoch, navigation)) throw this.recordingError
    }
    private publishMetadata(): void {
        if (this.state.status === 'paused')
            this.publish({ ...this.state, ...this.info, message: this.recordingMessage() ?? this.state.message })
        else if (this.state.status === 'exited' || this.state.status === 'running')
            this.publish({ ...this.state, ...this.info })
        else if (this.state.status === 'recording')
            this.publish({ status: 'recording', mode: 'replay', steps: this.trace.length })
    }
    private async initialStop(epoch: number, navigation: number): Promise<void> {
        let scanned = -1,
            revision = this.breakpointRevision
        while (this.active(epoch, navigation)) {
            if (revision !== this.breakpointRevision) {
                scanned = -1
                revision = this.breakpointRevision
            }
            if (this.recordingError) throw this.recordingError
            const version = this.version
            const frontier = this.trace.length - 1
            const enabled = this.editor.filter((bp) => bp.info.enabled)
            const hasValidBreakpoint = enabled.some((bp) => bp.info.verified || bp.failureAt !== undefined)
            if (frontier >= 0 && (this.req.stopAtEntry || !hasValidBreakpoint)) {
                await this.show(
                    this.entryIndex(),
                    'entry',
                    enabled.length && !hasValidBreakpoint ? '已启用的断点没有可用位置，已停在程序入口。' : undefined,
                    navigation
                )
                return
            }
            const target = await this.nextBreakpoint(scanned, frontier)
            if (!this.active(epoch, navigation)) return
            if (revision !== this.breakpointRevision) continue
            if (target !== undefined) {
                await this.show(target, 'breakpoint', undefined, navigation)
                return
            }
            if (this.info.recordingComplete) {
                if (this.info.recordingEnded && !this.info.resourceLimit)
                    await this.show(frontier, 'step', undefined, navigation)
                else {
                    const detail = this.info.resourceLimit
                        ? `${resourceMessage(this.info.resourceLimit)}；可浏览已录制步骤。`
                        : '可单步或继续执行。'
                    await this.show(
                        this.entryIndex(),
                        'entry',
                        `当前录制范围内未命中断点，已停在程序入口；${detail}`,
                        navigation
                    )
                }
                return
            }
            scanned = frontier
            await this.wait(epoch, navigation, version)
        }
    }
    private entryIndex(): number {
        const entry = this.trace.findIndex((snapshot) => snapshot.reason !== 'exited' && this.isUser(snapshot.file))
        return entry >= 0 ? entry : 0
    }
    private get current(): Snapshot {
        return this.trace[this.index]
    }
    private isUser(file?: string): boolean {
        if (!file) return false
        if (this.build.sourceFiles.some((source) => sameFile(source, file))) return true
        const relative = path.relative(path.dirname(this.build.sourcePath), file)
        return !relative.startsWith('..') && !path.isAbsolute(relative)
    }
    private depth(snapshot: Snapshot): number {
        return snapshot.frames.filter((f) => this.isUser(f.file)).length
    }
    private currentOutput(snapshot = this.current): {
        stdout: string
        stderr: string
        stdoutOffset: number
        stderrOffset: number
    } {
        return this.native.recordedOutput.view(snapshot.index, this.tools.displayLimitChars)
    }
    private async show(
        index: number,
        reason: Extract<DebugState, { status: 'paused' }>['reason'],
        message?: string,
        navigation = this.navigation
    ): Promise<void> {
        const epoch = this.epoch
        if (!this.active(epoch, navigation)) return
        const s = this.trace[index]
        this.index = index
        this.frame = s.frames.find((f) => this.isUser(f.file))?.level ?? 0
        this.info.totalSteps = this.trace.length
        const output = this.currentOutput()
        output.stdout = output.stdout.slice(-this.tools.displayLimitChars)
        output.stderr = output.stderr.slice(-this.tools.displayLimitChars)
        this.emit({ type: 'output', ...output })
        if (s.reason === 'exited')
            this.publish({
                status: 'exited',
                ...this.info,
                exitCode: s.exitCode ?? null,
                stdout: output.stdout,
                stderr: output.stderr,
                stepIndex: index,
                canStepBack: index > 0
            })
        else
            this.publish({
                status: 'paused',
                ...this.info,
                reason: s.signal ? 'signal' : reason,
                signal: s.signal,
                file: s.file,
                line: s.line,
                frame: this.frame,
                stepIndex: index,
                canStepBack: index > 0,
                message:
                    message ?? this.recordingMessage() ?? this.editor.find((bp) => bp.failureAt === index)?.info.error
            })
        // Browsing an existing snapshot never waits for an unsupported condition
        // elsewhere in its prefix. Publish only exact hit counts, when ready.
        if (this.editor.every((bp) => bp.prefix.length > index)) this.publishHits(index, navigation)
        else
            void this.refreshHits(index, navigation).catch((error) => {
                if (this.active(epoch, navigation) && this.state.status === 'paused')
                    this.publish({
                        ...this.state,
                        message: `断点命中次数计算失败：${error instanceof Error ? error.message : String(error)}`
                    })
            })
    }
    private serialize(work: () => Promise<void>): Promise<void> {
        const next = this.busy.then(work)
        this.busy = next.catch(() => {})
        return next
    }
    command(requested: DebugCommand): Promise<void> {
        // A held key shares the in-flight move. It must neither interrupt that
        // native move nor leave repeated commands queued after the key is released.
        const command = requested === 'next' ? 'stepOver' : requested
        if (!['stepIn', 'stepOver', 'stepOut', 'continue'].includes(command)) {
            this.pendingMovement = undefined
            return this.executeCommand(requested)
        }
        if (this.pendingMovement?.command === command) return this.pendingMovement.promise
        const work = this.executeCommand(requested)
        const promise = work.finally(() => {
            if (this.pendingMovement?.promise === promise) this.pendingMovement = undefined
        })
        this.pendingMovement = { command, promise }
        return promise
    }
    private executeCommand(requested: DebugCommand): Promise<void> {
        const command = requested === 'next' ? 'stepOver' : requested
        if (command === 'pause') {
            if (this.running) return this.native.interrupt()
            if (this.state.status === 'paused' || this.state.status === 'exited') this.newNavigation()
            return Promise.resolve()
        }
        // Native live execution must stop before another command browses or moves
        // its tail. Frontier waits, in contrast, never own the inferior.
        if (this.running)
            return this.native
                .interrupt()
                .then(() => this.busy)
                .then(() => this.executeCommand(requested))
        const navigation = this.newNavigation(),
            epoch = this.epoch
        if (command === 'restart')
            return this.cancellable(
                this.serialize(async () => {
                    if (!this.active(epoch, navigation)) return
                    if (this.info.recordingComplete && this.info.mode === 'replay' && !this.info.recordingError) {
                        await this.initialStop(epoch, navigation)
                        return
                    }
                    ++this.epoch
                    this.changed()
                    await this.native.dispose()
                    await this.recordingTask
                    if (this.disposed || navigation !== this.navigation) return
                    this.queries.clear()
                    this.refs.clear()
                    this.native = this.createNative()
                    await this.start()
                }),
                navigation
            )
        if (!this.trace.length || this.disposed || command === 'stop') return Promise.resolve()
        if (command === 'stepBack')
            return this.cancellable(this.show(Math.max(0, this.index - 1), 'step', undefined, navigation), navigation)
        return this.cancellable(
            (async () => {
                const origin = this.current,
                    depth = this.depth(origin)
                let scanned = this.index,
                    originReturned = false,
                    revision = this.breakpointRevision
                while (this.active(epoch, navigation)) {
                    if (command === 'continue' && revision !== this.breakpointRevision) {
                        scanned = origin.index
                        revision = this.breakpointRevision
                    }
                    const version = this.version,
                        frontier = this.trace.length - 1
                    let target: number | undefined
                    if (command === 'continue') target = await this.nextBreakpoint(scanned, frontier)
                    else
                        for (let i = scanned + 1; i <= frontier; i++) {
                            const candidate = this.trace[i],
                                candidateDepth = this.depth(candidate)
                            if (candidate.userEntry && candidateDepth === depth) originReturned = true
                            const returnOnCallLine =
                                candidate.returnSite &&
                                candidateDepth === depth &&
                                sameFile(candidate.file, origin.file) &&
                                candidate.line === origin.line
                            if (
                                command === 'stepIn' ||
                                (command === 'stepOver' &&
                                    candidateDepth <= depth &&
                                    (!originReturned || candidateDepth < depth) &&
                                    !returnOnCallLine) ||
                                (command === 'stepOut' && candidateDepth < depth)
                            ) {
                                target = i
                                break
                            }
                        }
                    if (!this.active(epoch, navigation)) return
                    if (command === 'continue' && revision !== this.breakpointRevision) continue
                    if (target !== undefined) {
                        await this.show(target, command === 'continue' ? 'breakpoint' : 'step', undefined, navigation)
                        return
                    }
                    if (!this.info.recordingComplete) {
                        scanned = frontier
                        await this.wait(epoch, navigation, version)
                        continue
                    }
                    if (this.info.mode === 'live' && !this.info.recordingEnded)
                        await this.serialize(async () => {
                            if (!this.active(epoch, navigation)) return
                            if (command === 'stepOut' && this.depth(this.trace[frontier]) <= 1) {
                                await this.show(frontier, 'step', '当前已是最外层函数', navigation)
                                return
                            }
                            await this.liveMove(
                                command === 'continue'
                                    ? 'continue'
                                    : command === 'stepIn'
                                      ? 'step'
                                      : command === 'stepOut'
                                        ? 'finish'
                                        : 'next'
                            )
                        })
                    else await this.show(frontier, 'step', undefined, navigation)
                    return
                }
            })(),
            navigation
        )
    }
    private async liveMove(command: 'step' | 'next' | 'finish' | 'continue', cursor?: BreakpointInfo): Promise<void> {
        const epoch = this.epoch,
            navigation = this.navigation
        if (this.index !== this.trace.length - 1) await this.show(this.trace.length - 1, 'step', undefined, navigation)
        if (!this.active(epoch, navigation)) return
        try {
            const snapshot = await this.native.advance(
                this.trace.length,
                command,
                [...(await this.breakpoints()), ...(cursor ? [cursor] : [])],
                () => {
                    if (!this.active(epoch, navigation)) throw new Error('调试操作已取消')
                    this.running = true
                    this.publish({ status: 'running', ...this.info, stepIndex: this.index })
                    // Start tailing only after a background seek restored the live frontier.
                    const tailer = this.native.outputTailer()
                    let polling = false
                    this.outputTimer = setInterval(() => {
                        if (polling) return
                        polling = true
                        void tailer
                            .poll({ verify: false })
                            .then((delta) => {
                                if (this.running && this.active(epoch, navigation)) this.emit(delta)
                            })
                            .catch((error) => {
                                if (
                                    error instanceof DebugLimitError &&
                                    this.running &&
                                    this.active(epoch, navigation)
                                ) {
                                    this.native.resourceLimit = error.limit
                                    void this.native.interrupt().catch(() => {})
                                }
                            })
                            .finally(() => {
                                polling = false
                            })
                    }, 100)
                }
            )
            this.running = false
            clearInterval(this.outputTimer)
            if (!this.active(epoch, navigation)) return
            this.trace.push(snapshot)
            if (snapshot.breakpointError) {
                const bp = this.editor.find((bp) => bp.info.id === snapshot.breakpointError!.id)
                if (bp) {
                    bp.info.verified = false
                    bp.info.error = `断点条件无效：${snapshot.breakpointError.error}`
                }
            }
            if (snapshot.reason === 'exited' || snapshot.reason === 'signal') {
                this.info.recordingEnded = true
                this.info.final = { exitCode: snapshot.exitCode ?? null, signal: snapshot.signal }
            }
            const atCursor = cursor && sameFile(snapshot.file, cursor.file) && snapshot.line === cursor.line
            await this.show(
                snapshot.index,
                snapshot.reason === 'pause'
                    ? 'pause'
                    : atCursor
                      ? 'cursor'
                      : command === 'continue'
                        ? 'breakpoint'
                        : 'step',
                snapshot.breakpointError ? `断点条件无效：${snapshot.breakpointError.error}` : undefined
            )
        } catch (error) {
            if (this.active(epoch, navigation) && this.state.status !== 'error') {
                const limit = error instanceof DebugLimitError ? error.limit : this.native.resourceLimit
                if (limit)
                    this.info = {
                        ...this.info,
                        mode: 'replay',
                        recordingComplete: true,
                        recordingEnded: true,
                        resourceLimit: limit,
                        final: undefined
                    }
                await this.show(
                    this.index,
                    'pause',
                    limit
                        ? resourceMessage(limit)
                        : `调试操作失败：${error instanceof Error ? error.message : String(error)}`
                )
            }
        } finally {
            this.running = false
            clearInterval(this.outputTimer)
        }
    }
    seek(index: number): Promise<void> {
        this.pendingMovement = undefined
        if (this.running)
            return this.native
                .interrupt()
                .then(() => this.busy)
                .then(() => this.seek(index))
        const navigation = this.newNavigation(),
            epoch = this.epoch
        return this.cancellable(
            (async () => {
                if (!Number.isInteger(index) || index < 0) throw new Error('调试步骤超出记录范围')
                while (this.active(epoch, navigation) && index >= this.trace.length && !this.info.recordingComplete) {
                    await this.wait(epoch, navigation, this.version)
                }
                if (!this.active(epoch, navigation)) return
                if (index >= this.trace.length) throw new Error('调试步骤超出记录范围')
                await this.show(index, 'seek', undefined, navigation)
            })(),
            navigation
        )
    }
    runToCursor(file: string, line: number): Promise<void> {
        this.pendingMovement = undefined
        if (this.running)
            return this.native
                .interrupt()
                .then(() => this.busy)
                .then(() => this.runToCursor(file, line))
        const navigation = this.newNavigation(),
            epoch = this.epoch,
            origin = this.index
        return this.cancellable(
            (async () => {
                let target = this.trace.findIndex((s, i) => i > origin && sameFile(s.file, file) && s.line === line)
                const resolved = target >= 0 ? line : await this.native.resolveLine(file, line)
                let scanned = origin
                while (this.active(epoch, navigation)) {
                    const version = this.version,
                        frontier = this.trace.length - 1
                    target = this.trace.findIndex(
                        (s, i) => i > scanned && sameFile(s.file, file) && s.line === (resolved ?? line)
                    )
                    if (target >= 0) {
                        await this.show(target, 'cursor', undefined, navigation)
                        return
                    }
                    if (!this.info.recordingComplete) {
                        scanned = frontier
                        await this.wait(epoch, navigation, version)
                        continue
                    }
                    if (this.info.mode === 'live' && !this.info.recordingEnded)
                        await this.serialize(async () => {
                            if (this.active(epoch, navigation))
                                await this.liveMove('continue', {
                                    id: -1,
                                    file,
                                    line: resolved ?? line,
                                    enabled: true,
                                    verified: true,
                                    hits: 0
                                })
                        })
                    else await this.show(frontier, 'step', undefined, navigation)
                    return
                }
            })(),
            navigation
        )
    }
    async selectFrame(level: number): Promise<void> {
        if (!this.current?.frames.some((f) => f.level === level)) throw new Error('无效的调用栈层级')
        this.frame = level
        if (this.state.status === 'paused') this.publish({ ...this.state, frame: level })
    }
    async stack(): Promise<StackFrame[]> {
        return this.current?.frames.map(({ level, func, file, line }) => ({ level, func, file, line })) ?? []
    }
    private variables(nodes: ValueNode[], index = this.index, frame = this.frame): Variable[] {
        return nodes.map((node) => {
            if (node.hasChildren) {
                const key = `${index}:${frame}:${node.selector?.expression ?? node.name}:${JSON.stringify(node.selector?.path ?? [])}`
                node.ref = key
                this.refs.set(key, { index, frame, node })
            }
            return publicVariable(node)
        })
    }
    async locals(): Promise<Variable[]> {
        if (!this.current) return []
        const local = this.current.frames.find((f) => f.level === this.frame)?.locals ?? []
        return this.variables([...local, ...this.current.globals])
    }
    private query(
        index: number,
        frame: number,
        expression: string,
        childPath: number[] = [],
        readOnly = false
    ): Promise<ValueNode> {
        const key = JSON.stringify([index, frame, expression, childPath, readOnly])
        let result = this.queries.get(key)
        if (!result) {
            result = this.native.query(index, frame, expression, childPath, readOnly)
            this.queries.set(key, result)
            void result.catch(() => {
                if (this.queries.get(key) === result) this.queries.delete(key)
            })
        }
        return result
    }
    async children(ref: string): Promise<Variable[]> {
        const epoch = this.epoch
        const item = this.refs.get(ref)
        if (!item || item.index !== this.index) return []
        let node = item.node
        if (node.truncated && node.selector)
            node = await this.query(item.index, item.frame, node.selector.expression, node.selector.path)
        if (!this.active(epoch) || item.index !== this.index) return []
        return this.variables(node.children ?? [], item.index, item.frame)
    }
    inspect(expression: string): Promise<{ value: string; type?: string } | null> {
        return this.evaluate(expression, true)
    }
    async evaluate(expression: string, readOnly = false): Promise<{ value: string; type?: string } | null> {
        if (!this.current?.frames.length) return null
        const value = evaluateCaptured(
            expression,
            this.current.frames.find((f) => f.level === this.frame)?.locals ?? [],
            this.current.globals
        )
        if (value && !value.node?.truncated) return { value: value.value, type: value.type }
        const index = this.index,
            frame = this.frame,
            epoch = this.epoch
        try {
            const exact = await this.query(index, frame, expression, [], readOnly)
            if (!this.active(epoch) || index !== this.index || frame !== this.frame) return null
            if (exact.unavailable) return null
            return { value: exact.value, type: exact.type }
        } catch (error) {
            if (!readOnly && this.active(epoch) && this.state.status === 'paused' && this.index === index)
                this.publish({
                    ...this.state,
                    message: `求值失败：${error instanceof Error ? error.message : String(error)}`
                })
            return null
        }
    }
    private replaceBreakpoints(file: string, bps: Breakpoint[]): void {
        ++this.breakpointRevision
        const old = this.editor.filter((bp) => sameFile(bp.info.file, file))
        this.editor = this.editor.filter((bp) => !sameFile(bp.info.file, file))
        for (const bp of bps)
            this.editor.push({
                requested: bp.line,
                info: {
                    ...bp,
                    file,
                    id: old.find((b) => b.requested === bp.line)?.info.id ?? this.nextId++,
                    hits: 0,
                    verified: true
                },
                matches: new Map(),
                prefix: []
            })
    }
    async setBreakpoints(file: string, bps: Breakpoint[]): Promise<void> {
        if (this.disposed) return
        const normalized = file.replace(/\\/g, '/'),
            key = process.platform === 'win32' ? normalized.toLowerCase() : normalized,
            edit = ++this.breakpointEdit
        this.breakpointEdits.set(key, edit)
        bps = bps.map((bp) => ({ ...bp }))
        if (!this.initialized) {
            this.replaceBreakpoints(file, bps)
            this.changed()
            return
        }
        if (this.running) await this.native.interrupt()
        await this.serialize(async () => {
            if (this.disposed || this.breakpointEdits.get(key) !== edit) return
            this.replaceBreakpoints(file, bps)
            await this.verifyBreakpoints()
            if (this.disposed || this.breakpointEdits.get(key) !== edit) return
            if (this.trace.length) {
                await this.prepareReplayBreakpoints()
                await this.refreshHits()
            }
            this.changed()
        })
    }
    private async verifyBreakpoints(): Promise<void> {
        const revision = this.breakpointRevision
        for (const bp of this.editor) {
            const info = bp.info
            const resolved = await this.native.resolveLine(info.file, bp.requested)
            if (revision !== this.breakpointRevision || this.disposed) return
            info.line = resolved ?? bp.requested
            info.verified = resolved !== null
            info.error = info.verified ? undefined : '该位置没有可用的调试符号'
            if (
                info.hitCondition !== undefined &&
                (!Number.isSafeInteger(info.hitCondition) || info.hitCondition < 1)
            ) {
                info.verified = false
                info.error = '命中次数必须是正整数'
            }
            if (info.verified && info.condition) {
                const index = this.trace.findIndex((s) => sameFile(s.file, info.file) && s.line === info.line)
                if (index >= 0) await this.matches(bp, index)
            }
        }
    }
    private async prepareReplayBreakpoints(): Promise<void> {
        // Do exact condition work when the editor list changes, so completed-trace
        // navigation (including hit-count updates) never has to execute GDB.
        if (this.info.mode === 'replay') for (const bp of this.editor) await this.ensureHits(bp, this.trace.length - 1)
    }
    private async matches(bp: EditorBreakpoint, index: number): Promise<boolean> {
        const epoch = this.epoch
        const info = bp.info,
            snapshot = this.trace[index]
        if (!info.enabled || !info.verified || !sameFile(snapshot.file, info.file) || snapshot.line !== info.line)
            return false
        if (bp.matches.has(index)) return bp.matches.get(index)!
        let matches = true
        if (info.condition) {
            const frame = snapshot.frames.find((f) => this.isUser(f.file))
            const captured = evaluateCaptured(`!!(${info.condition})`, frame?.locals ?? [], snapshot.globals)
            if (captured?.scalar) matches = captured.value === 'true' || captured.value === '1'
            else
                try {
                    const result = await this.query(index, frame?.level ?? 0, `!!(${info.condition})`)
                    if (!this.active(epoch)) return false
                    if (result.unavailable || !result.scalar) throw new Error('无法精确求值断点条件')
                    matches = result.scalar.value !== '0'
                } catch (error) {
                    if (!this.active(epoch)) return false
                    info.verified = false
                    info.error = `断点条件无效：${error instanceof Error ? error.message : String(error)}`
                    bp.failureAt = index
                    matches = false
                }
        }
        bp.matches.set(index, matches)
        return matches
    }
    private async nextBreakpoint(after: number, through = this.trace.length - 1): Promise<number | undefined> {
        for (const bp of this.editor) await this.ensureHits(bp, after)
        for (let i = after + 1; i <= through; i++) {
            for (const bp of this.editor) {
                await this.ensureHits(bp, i)
                if (
                    (bp.failureAt === i && bp.info.enabled) ||
                    (bp.prefix[i] > (bp.prefix[i - 1] ?? 0) && bp.prefix[i] >= (bp.info.hitCondition ?? 1))
                )
                    return i
            }
        }
        return undefined
    }
    private async ensureHits(bp: EditorBreakpoint, index: number): Promise<void> {
        if (bp.prefix.length > index) return
        const epoch = this.epoch
        const work = (bp.work ?? Promise.resolve()).then(async () => {
            for (let i = bp.prefix.length; i <= index && i < this.trace.length; i++) {
                if (!this.active(epoch)) return
                const matched = await this.matches(bp, i)
                if (!this.active(epoch)) return
                const native = this.trace[i].breakpointHits?.[String(bp.info.id)]
                const sameCondition =
                    bp.info.enabled &&
                    native &&
                    sameFile(native.file, bp.info.file) &&
                    native.line === bp.info.line &&
                    (native.condition ?? '') === (bp.info.condition ?? '')
                bp.prefix.push(sameCondition ? native.hits : (bp.prefix[i - 1] ?? 0) + (matched ? 1 : 0))
            }
        })
        bp.work = work.catch(() => {})
        await work
    }
    private async refreshHits(index = this.index, navigation = this.navigation): Promise<void> {
        for (const bp of this.editor) await this.ensureHits(bp, index)
        this.publishHits(index, navigation)
    }
    private publishHits(index: number, navigation: number): void {
        if (!this.active(this.epoch, navigation)) return
        for (const bp of this.editor) bp.info.hits = bp.prefix[index] ?? 0
        this.emit({ type: 'breakpoints', breakpoints: this.editor.map((bp) => ({ ...bp.info })) })
    }
    async breakpoints(): Promise<BreakpointInfo[]> {
        if (this.trace.length) await this.refreshHits()
        return this.editor.map((bp) => ({ ...bp.info }))
    }
    dispose(): Promise<void> {
        return (this.disposing ??= (async () => {
            this.disposed = true
            ++this.epoch
            this.newNavigation()
            clearInterval(this.outputTimer)
            await this.native.dispose()
            await this.recordingTask
        })())
    }
}
