import type {
    Breakpoint,
    BreakpointInfo,
    DebugCommand,
    DebugEvent,
    DebugStartRequest,
    StackFrame,
    Variable
} from '../../shared/debug'
import type { ToolchainSettings } from '../../shared/judge'
import type { JudgeEngine } from '../judge/engine'
import { buildDebug, removeBuild, type DebugBuild } from './build'
import { DebugSession } from './session'
import { acquireProblemLease } from '../problem/store'
import path from 'node:path'
import { debugBreakpoints, debugCommand, debugIndex, debugRequest, debugText } from './requests'
import { isReadOnlyDebugExpression } from '../../shared/debugExpression'

interface PendingBreakpoints {
    file: string
    points: Breakpoint[]
}
interface ActiveSession {
    abort: AbortController
    breakpoints: Map<string, PendingBreakpoints>
    session?: DebugSession
    build?: DebugBuild
    startup?: Promise<void>
    cleanup?: Promise<void>
    release?: () => void
}
const breakpointKey = (file: string): string =>
    process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)
export class DebugManager {
    private active?: ActiveSession
    private disposed = false
    private disposing?: Promise<void>
    private inspection?: {
        session: DebugSession
        expression: string
        work: Promise<{ value: string; type?: string } | null>
    }
    private readonly starts = new Set<Promise<void>>()
    constructor(
        _judge: JudgeEngine,
        private readonly toolchain: () => ToolchainSettings,
        private readonly emit: (event: DebugEvent) => void
    ) {}
    private get session(): DebugSession | undefined {
        return !this.disposed && !this.active?.abort.signal.aborted ? this.active?.session : undefined
    }
    private cleanup(active: ActiveSession): Promise<void> {
        active.abort.abort()
        return (active.cleanup ??= (async () => {
            try {
                await active.session?.dispose()
                await active.startup?.catch(() => {})
                await active.session?.dispose()
                if (active.build) await removeBuild(active.build.dir)
            } finally {
                active.release?.()
                active.release = undefined
            }
        })().catch((error) => {
            active.cleanup = undefined
            throw error
        }))
    }
    async start(req: DebugStartRequest): Promise<void> {
        if (this.disposed) throw new Error('Debug manager is disposed')
        req = debugRequest(req)
        const previous = this.active,
            active: ActiveSession = {
                abort: new AbortController(),
                breakpoints: new Map([
                    [breakpointKey(req.sourcePath), { file: path.resolve(req.sourcePath), points: req.breakpoints }]
                ])
            }
        this.active = active
        const startup = (async () => {
            if (previous) await this.cleanup(previous)
            if (this.active !== active) return
            this.emit({ type: 'state', state: { status: 'starting' } })
            active.release = await acquireProblemLease(req.sourcePath)
            active.abort.signal.throwIfAborted()
            const tools = { ...this.toolchain() }
            const build = await buildDebug(req, tools, active.abort.signal)
            active.build = build
            if (this.active !== active || active.abort.signal.aborted) return
            active.session = new DebugSession(
                build,
                { ...req, breakpoints: active.breakpoints.get(breakpointKey(build.sourcePath))?.points ?? [] },
                tools,
                (event) => {
                    if (this.active === active && !active.abort.signal.aborted) {
                        this.emit(event)
                        if (event.type === 'state' && event.state.status === 'error')
                            void this.cleanup(active).catch(() => {})
                    }
                }
            )
            // Calls below update only the session's model until GDB initialization has finished.
            // Invoke every seed before yielding, so a newer edit cannot be overwritten by an older seed.
            await Promise.all(
                [...active.breakpoints.values()].map(({ file, points }) => active.session!.setBreakpoints(file, points))
            )
            if (this.active !== active || active.abort.signal.aborted) return
            await active.session.start()
        })()
        active.startup = startup
        this.starts.add(startup)
        try {
            await startup
        } catch (error) {
            if (this.active === active && !active.abort.signal.aborted) {
                this.emit({
                    type: 'state',
                    state: { status: 'error', message: error instanceof Error ? error.message : String(error) }
                })
            }
            await this.cleanup(active)
        } finally {
            this.starts.delete(startup)
        }
    }
    async command(command: DebugCommand): Promise<void> {
        command = debugCommand(command)
        const active = this.active
        if (!active) return
        if (command === 'stop') {
            await this.cleanup(active)
            if (this.active === active) this.active = undefined
            if (!this.active) this.emit({ type: 'state', state: { status: 'idle' } })
        } else
            try {
                await this.session?.command(command)
            } catch (error) {
                if (command !== 'restart') throw error
                if (this.active === active && !active.abort.signal.aborted) {
                    this.emit({
                        type: 'state',
                        state: { status: 'error', message: error instanceof Error ? error.message : String(error) }
                    })
                    await this.cleanup(active)
                }
            }
    }
    async setBreakpoints(file: string, breakpoints: Breakpoint[]): Promise<void> {
        file = debugText(file, 'sourcePath', 32_768)
        breakpoints = debugBreakpoints(breakpoints)
        const active = this.active
        if (!active || active.abort.signal.aborted) return
        const points = breakpoints.map((bp) => ({ ...bp })),
            absolute = path.resolve(file)
        active.breakpoints.set(breakpointKey(absolute), { file: absolute, points })
        await active.session?.setBreakpoints(absolute, points)
    }
    async evaluate(expr: string): Promise<{ value: string; type?: string } | null> {
        expr = debugText(expr, 'expression')
        return this.session?.evaluate(expr) ?? null
    }
    async inspect(expr: string): Promise<{ value: string; type?: string } | null> {
        expr = debugText(expr, 'expression', 4096)
        const session = this.session
        if (!session || !isReadOnlyDebugExpression(expr)) return null
        const pending = this.inspection
        // Automatic hovers may be abandoned without cancelling an IPC invocation.
        // Share the same expression; a different hover can retry after this one settles.
        if (pending?.session === session) return pending.expression === expr ? pending.work : null
        const work = session.inspect(expr).then((value) => (this.session === session ? value : null))
        const inspection = { session, expression: expr, work }
        this.inspection = inspection
        try {
            return await work
        } finally {
            if (this.inspection === inspection) this.inspection = undefined
        }
    }
    async locals(): Promise<Variable[]> {
        return this.session?.locals() ?? []
    }
    async children(ref: string): Promise<Variable[]> {
        ref = debugText(ref, 'reference')
        return this.session?.children(ref) ?? []
    }
    async stack(): Promise<StackFrame[]> {
        return this.session?.stack() ?? []
    }
    async runToCursor(file: string, line: number): Promise<void> {
        file = debugText(file, 'sourcePath', 32_768)
        line = debugIndex(line, 'line', 1)
        await this.session?.runToCursor(file, line)
    }
    async selectFrame(level: number): Promise<void> {
        level = debugIndex(level, 'frame')
        await this.session?.selectFrame(level)
    }
    async breakpoints(): Promise<BreakpointInfo[]> {
        return this.session?.breakpoints() ?? []
    }
    async seek(index: number): Promise<void> {
        index = debugIndex(index, 'step')
        await this.session?.seek(index)
    }
    dispose(): Promise<void> {
        return (this.disposing ??= (async () => {
            this.disposed = true
            const active = this.active
            if (active) await this.cleanup(active)
            if (this.active === active) this.active = undefined
            await Promise.allSettled([...this.starts])
        })().catch((error) => {
            this.disposing = undefined
            throw error
        }))
    }
}
