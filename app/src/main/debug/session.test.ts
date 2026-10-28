import { describe, expect, it, vi } from 'vitest'
import type { DebugEvent, DebugStartRequest, DebugState } from '../../shared/debug'
import type { DebugBuild } from './build'
import type { ToolchainSettings } from '../../shared/judge'
import type { RecordResult, Snapshot, ValueNode } from './trace'
import { DebugSession } from './session'

const recorder = vi.hoisted(() => ({
    append: undefined as unknown as (batch: Snapshot[]) => void,
    finish: undefined as unknown as (result: RecordResult) => void,
    fail: undefined as unknown as (error: Error) => void,
    location: undefined as Promise<number | null> | undefined,
    initialize: undefined as Promise<void> | undefined,
    resolve: undefined as ((file: string, line: number) => Promise<number | null>) | undefined,
    resolved: [] as number[],
    query: undefined as Promise<ValueNode> | undefined,
    advance: undefined as (() => Promise<Snapshot>) | undefined,
    interrupts: 0,
    initializations: 0,
    records: 0
}))
vi.mock('./native', () => ({
    NativeDebugger: class {
        recordedOutput = { view: () => ({ stdout: '', stderr: '', stdoutOffset: 0, stderrOffset: 0 }) }
        async initialize() {
            recorder.initializations++
            await recorder.initialize
        }
        async resolveLine(file: string, line: number) {
            recorder.resolved.push(line)
            return recorder.resolve ? recorder.resolve(file, line) : (recorder.location ?? line)
        }
        async query() {
            return recorder.query
        }
        async advance(_index: number, _command: string, _bps: unknown, ready: () => void) {
            ready()
            return recorder.advance!()
        }
        outputTailer() {
            return { poll: async () => ({ type: 'output-delta', stdoutOffset: 0, stderrOffset: 0 }) }
        }
        async interrupt() {
            recorder.interrupts++
        }
        record(append: (batch: Snapshot[]) => void) {
            recorder.records++
            recorder.append = append
            return new Promise<RecordResult>((resolve, reject) => {
                recorder.finish = resolve
                recorder.fail = reject
            })
        }
        async dispose() {
            recorder.finish?.({ snapshots: [], ended: false, elapsedMs: 0 })
        }
    }
}))

const file = 'D:/test/main.cpp'
function snapshot(index: number, line: number, depth = 1): Snapshot {
    return {
        index,
        file,
        line,
        reason: 'step',
        frames: Array.from({ length: depth }, (_, level) => ({
            level,
            file,
            line,
            func: level ? 'main' : 'f',
            locals: []
        })),
        globals: [],
        stdoutOffset: 0,
        stderrOffset: 0,
        fileOutputOffset: 0,
        signature: '',
        fingerprint: ''
    }
}
function startingFixture(request: Partial<DebugStartRequest> = {}, configure?: () => void) {
    recorder.append = undefined!
    recorder.finish = undefined!
    recorder.location = undefined
    recorder.query = undefined
    recorder.initialize = undefined
    recorder.resolve = undefined
    recorder.resolved = []
    recorder.advance = undefined
    recorder.interrupts = 0
    recorder.initializations = 0
    recorder.records = 0
    configure?.()
    const events: DebugEvent[] = []
    let state: DebugState = { status: 'idle' }
    const session = new DebugSession(
        { sourcePath: file, sourceFiles: [file] } as DebugBuild,
        { sourcePath: file, source: '', breakpoints: [], stopAtEntry: true, ...request },
        {} as ToolchainSettings,
        (event) => {
            events.push(event)
            if (event.type === 'state') state = event.state
        }
    )
    const starting = session.start()
    return { session, events, state: () => state, starting }
}
async function fixture() {
    const f = startingFixture()
    await vi.waitFor(() => expect(recorder.append).toBeTypeOf('function'))
    recorder.append([snapshot(0, 1)])
    await f.starting
    return f
}
async function pending(work: Promise<void>): Promise<() => boolean> {
    let done = false
    void work.then(() => {
        done = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(done).toBe(false)
    return () => done
}
describe('progressive trace navigation', () => {
    it('starts a fresh native recording after a failure while keeping the old prefix available until restart', async () => {
        const f = await fixture()
        try {
            recorder.append([snapshot(1, 2)])
            recorder.fail(new Error('GDB exited'))
            await vi.waitFor(() =>
                expect(f.state()).toMatchObject({ recordingComplete: true, recordingError: 'GDB exited' })
            )
            await f.session.seek(1)
            expect(f.state()).toMatchObject({ stepIndex: 1 })
            const restarted = f.session.command('restart')
            await vi.waitFor(() => expect(recorder.records).toBe(2))
            recorder.append([snapshot(0, 10)])
            await restarted
            expect(recorder.initializations).toBe(2)
            expect(f.state()).toMatchObject({
                status: 'paused',
                stepIndex: 0,
                line: 10,
                recordingComplete: false,
                recordingEnded: false
            })
            expect(f.state()).not.toHaveProperty('recordingError')
        } finally {
            await f.session.dispose()
        }
    })
    it('coalesces superseded breakpoint edits without executing every queued verification', async () => {
        const f = await fixture()
        let release!: (line: number) => void
        try {
            recorder.resolve = async (_file, line) =>
                line === 50
                    ? new Promise<number>((resolve) => {
                          release = resolve
                      })
                    : line
            const first = f.session.setBreakpoints(file, [{ line: 50, enabled: true }])
            await vi.waitFor(() => expect(recorder.resolved).toEqual([50]))
            const edits = Array.from({ length: 100 }, (_, i) =>
                f.session.setBreakpoints(file, [{ line: 51 + i, enabled: true }])
            )
            release(50)
            await Promise.all([first, ...edits])
            expect(recorder.resolved).toEqual([50, 150])
            expect(await f.session.breakpoints()).toMatchObject([{ line: 150, enabled: true, verified: true }])
        } finally {
            release?.(50)
            await f.session.dispose()
        }
    })
    it('coalesces held-F10 repeats while waiting for more recorded steps', async () => {
        const f = await fixture()
        try {
            const moving = f.session.command('stepOver')
            const repeated = Array.from({ length: 100 }, () => f.session.command('stepOver'))
            recorder.append([snapshot(1, 2)])
            await Promise.all([moving, ...repeated])
            expect(f.state()).toMatchObject({ stepIndex: 1, recordingComplete: false })
            expect(recorder.interrupts).toBe(0)
        } finally {
            await f.session.dispose()
        }
    })
    it('does not interrupt or queue duplicate live steps when F10 repeats at the capped frontier', async () => {
        const f = await fixture()
        let advance!: (snapshot: Snapshot) => void,
            calls = 0
        try {
            recorder.finish({ snapshots: [], ended: false, elapsedMs: 5, limited: 'steps' })
            await vi.waitFor(() => expect(f.state()).toMatchObject({ recordingComplete: true }))
            recorder.advance = () => {
                calls++
                return new Promise((resolve) => {
                    advance = resolve
                })
            }
            const moving = f.session.command('stepOver')
            await vi.waitFor(() => expect(f.state()).toMatchObject({ status: 'running' }))
            const repeated = Array.from({ length: 100 }, () => f.session.command('stepOver'))
            await new Promise((resolve) => setTimeout(resolve, 0))
            expect(recorder.interrupts).toBe(0)
            advance(snapshot(1, 2))
            await Promise.all([moving, ...repeated])
            expect(calls).toBe(1)
            expect(f.state()).toMatchObject({ status: 'paused', stepIndex: 1 })
        } finally {
            advance?.(snapshot(1, 2))
            await f.session.dispose()
        }
    })
    it.each(['steps', 'time', 'python-unavailable'] as const)(
        'retains the %s fallback reason while browsing the recorded prefix',
        async (limited) => {
            const f = await fixture()
            try {
                recorder.append([snapshot(1, 2)])
                recorder.finish({ snapshots: [], ended: false, elapsedMs: 30_000, limited })
                await vi.waitFor(() =>
                    expect(f.state()).toMatchObject({
                        recordingComplete: true,
                        recordingLimit: limited,
                        recordingLimits: { maxSteps: 20000, maxDurationMs: 30000 },
                        message: expect.any(String)
                    })
                )
                await f.session.seek(1)
                expect(f.state()).toMatchObject({ stepIndex: 1, recordingLimit: limited, message: expect.any(String) })
                await f.session.command('stepBack')
                expect(f.state()).toMatchObject({ stepIndex: 0, recordingLimit: limited, message: expect.any(String) })
            } finally {
                await f.session.dispose()
            }
        }
    )
    it('retains captured navigation and reports a recorder failure without claiming a normal exit', async () => {
        const f = await fixture()
        try {
            recorder.append([snapshot(1, 2), snapshot(2, 3)])
            recorder.fail(new Error('broken trace stream'))
            await vi.waitFor(() =>
                expect(f.state()).toMatchObject({
                    status: 'paused',
                    mode: 'replay',
                    recordingComplete: true,
                    recordingEnded: false,
                    recordingError: 'broken trace stream',
                    message: expect.stringContaining('broken trace stream')
                })
            )
            await f.session.seek(2)
            expect(f.state()).toMatchObject({ stepIndex: 2, message: expect.stringContaining('broken trace stream') })
            await f.session.command('stepBack')
            expect(f.state()).toMatchObject({ stepIndex: 1, recordingEnded: false })
            await f.session.command('continue')
            expect(f.state()).toMatchObject({ status: 'paused', stepIndex: 2, recordingEnded: false })
        } finally {
            await f.session.dispose()
        }
    })
    it('starts at entry when breakpoints were cleared while startup was still initializing', async () => {
        let initialize!: () => void
        const f = startingFixture({ stopAtEntry: false, breakpoints: [{ line: 49, enabled: true }] }, () => {
            recorder.initialize = new Promise<void>((resolve) => {
                initialize = resolve
            })
        })
        try {
            await f.session.setBreakpoints(file, [])
            initialize()
            await vi.waitFor(() => expect(recorder.append).toBeTypeOf('function'))
            recorder.append([snapshot(0, 1), snapshot(1, 2)])
            recorder.finish({ snapshots: [], ended: false, elapsedMs: 30_000, limited: 'time' })
            await f.starting
            expect(f.state()).toMatchObject({ status: 'paused', stepIndex: 0, line: 1, reason: 'entry' })
        } finally {
            initialize()
            await f.session.dispose()
        }
    })
    it('falls back to entry with an explicit message when recording reaches a budget before any breakpoint hit', async () => {
        const f = startingFixture({ stopAtEntry: false, breakpoints: [{ line: 49, enabled: true }] })
        try {
            await vi.waitFor(() => expect(recorder.append).toBeTypeOf('function'))
            recorder.append([snapshot(0, 1), snapshot(1, 2), snapshot(2, 3)])
            recorder.finish({ snapshots: [], ended: false, elapsedMs: 30_000, limited: 'time' })
            await f.starting
            expect(f.state()).toMatchObject({
                status: 'paused',
                stepIndex: 0,
                line: 1,
                reason: 'entry',
                mode: 'live',
                recordingComplete: true,
                recordingEnded: false,
                message: expect.stringContaining('未命中')
            })
            await f.session.seek(2)
            expect(f.state()).toMatchObject({ stepIndex: 2, line: 3 })
        } finally {
            await f.session.dispose()
        }
    })
    it('pauses at entry promptly when all enabled breakpoints have no symbols', async () => {
        const f = startingFixture({ stopAtEntry: false, breakpoints: [{ line: 49, enabled: true }] }, () => {
            recorder.location = Promise.resolve(null)
        })
        try {
            await vi.waitFor(() => expect(recorder.append).toBeTypeOf('function'))
            recorder.append([snapshot(0, 1), snapshot(1, 2)])
            await vi.waitFor(() =>
                expect(f.state()).toMatchObject({
                    status: 'paused',
                    stepIndex: 0,
                    reason: 'entry',
                    recordingComplete: false
                })
            )
            await f.starting
        } finally {
            await f.session.dispose()
        }
    })
    it('verifies the latest revision after an initialization-time breakpoint edit, without resolving it prematurely', async () => {
        let resolveLine!: (line: number) => void
        const f = startingFixture({ stopAtEntry: false, breakpoints: [{ line: 5, enabled: true }] }, () => {
            recorder.resolve = async (_file, line) =>
                line === 5
                    ? new Promise<number>((resolve) => {
                          resolveLine = resolve
                      })
                    : line
        })
        try {
            await vi.waitFor(() => expect(recorder.resolved).toEqual([5]))
            const update = f.session.setBreakpoints(file, [{ line: 7, enabled: true }])
            await new Promise((resolve) => setTimeout(resolve, 0))
            expect(recorder.resolved).toEqual([5])
            resolveLine(5)
            await update
            await vi.waitFor(() => expect(recorder.append).toBeTypeOf('function'))
            recorder.append([snapshot(0, 1), snapshot(1, 7)])
            await f.starting
            expect(recorder.resolved).toEqual([5, 7])
            expect(f.state()).toMatchObject({ stepIndex: 1, line: 7, reason: 'breakpoint', recordingComplete: false })
        } finally {
            resolveLine?.(5)
            await f.session.dispose()
        }
    })
    it('preserves a real terminal exit when a valid breakpoint was never reached', async () => {
        const f = startingFixture({ stopAtEntry: false, breakpoints: [{ line: 49, enabled: true }] })
        try {
            await vi.waitFor(() => expect(recorder.append).toBeTypeOf('function'))
            recorder.append([snapshot(0, 1), { ...snapshot(1, 0, 0), reason: 'exited', exitCode: 0 }])
            recorder.finish({ snapshots: [], ended: true, elapsedMs: 5 })
            await f.starting
            expect(f.state()).toMatchObject({ status: 'exited', stepIndex: 1, exitCode: 0, recordingEnded: true })
        } finally {
            await f.session.dispose()
        }
    })
    it('keeps a hard recording budget distinct from a real terminal exit', async () => {
        const f = startingFixture({ stopAtEntry: false, breakpoints: [{ line: 49, enabled: true }] })
        try {
            await vi.waitFor(() => expect(recorder.append).toBeTypeOf('function'))
            recorder.append([snapshot(0, 1), snapshot(1, 2)])
            recorder.finish({ snapshots: [], ended: true, elapsedMs: 5, limited: 'nodes' })
            await f.starting
            expect(f.state()).toMatchObject({
                status: 'paused',
                reason: 'entry',
                stepIndex: 0,
                mode: 'replay',
                resourceLimit: 'nodes',
                message: expect.stringContaining('未命中')
            })
            const state = f.state()
            expect('final' in state ? state.final : undefined).toBeUndefined()
        } finally {
            await f.session.dispose()
        }
    })
    it('matches the resolved top-level source stop rather than a caller frame on the breakpoint line', async () => {
        const f = startingFixture({ stopAtEntry: false, breakpoints: [{ line: 49, enabled: true }] }, () => {
            recorder.location = Promise.resolve(50)
        })
        try {
            await vi.waitFor(() => expect(recorder.append).toBeTypeOf('function'))
            const nested = snapshot(1, 14, 2)
            nested.frames[1].line = 50
            recorder.append([snapshot(0, 1), nested])
            await pending(f.starting)
            recorder.append([snapshot(2, 50)])
            await f.starting
            expect(f.state()).toMatchObject({
                status: 'paused',
                reason: 'breakpoint',
                stepIndex: 2,
                line: 50,
                recordingComplete: false
            })
            expect((await f.session.breakpoints())[0]).toMatchObject({ line: 50, hits: 1 })
        } finally {
            await f.session.dispose()
        }
    })
    it('publishes captured navigation immediately while exact breakpoint hit counts are still pending', async () => {
        const f = await fixture()
        let resolve!: (value: ValueNode) => void
        try {
            await f.session.setBreakpoints(file, [{ line: 10, enabled: true, condition: 'unknown()' }])
            recorder.query = new Promise((done) => {
                resolve = done
            })
            recorder.append([snapshot(1, 10)])
            await f.session.seek(1)
            expect(f.state()).toMatchObject({ stepIndex: 1, line: 10 })
            await f.session.command('stepBack')
            expect(f.state()).toMatchObject({ stepIndex: 0, line: 1 })
            resolve({
                name: 'condition',
                value: 'true',
                hasChildren: false,
                scalar: { kind: 'int', value: '1', bits: 8, signed: false }
            })
            await new Promise((done) => setTimeout(done, 0))
            expect(f.events.filter((e) => e.type === 'breakpoints').at(-1)).toMatchObject({
                breakpoints: [{ hits: 0 }]
            })
        } finally {
            await f.session.dispose()
        }
    })
    it('rechecks an edited breakpoint against the captured prefix while continue is waiting', async () => {
        const f = await fixture()
        try {
            recorder.append([snapshot(1, 2), snapshot(2, 3)])
            const continuing = f.session.command('continue')
            await pending(continuing)
            await f.session.setBreakpoints(file, [{ line: 2, enabled: true }])
            await continuing
            expect(f.state()).toMatchObject({ stepIndex: 1, reason: 'breakpoint', recordingComplete: false })
        } finally {
            await f.session.dispose()
        }
    })
    it('releases a cancelled cursor wait even while a native symbol query is still pending', async () => {
        const f = await fixture()
        let resolve!: (line: number) => void
        recorder.location = new Promise<number>((done) => {
            resolve = done
        })
        try {
            const cursor = f.session.runToCursor(file, 9)
            await f.session.seek(0)
            await cursor
            resolve(9)
            recorder.append([snapshot(1, 9)])
            await new Promise((done) => setTimeout(done, 0))
            expect(f.state()).toMatchObject({ stepIndex: 0, line: 1 })
        } finally {
            await f.session.dispose()
        }
    })
    it('keeps step-over and step-out searches alive across deeper-frame batches', async () => {
        const f = await fixture()
        try {
            const over = f.session.command('stepOver'),
                overDone = await pending(over)
            recorder.append([snapshot(1, 10, 2), snapshot(2, 11, 2)])
            await new Promise((resolve) => setTimeout(resolve, 0))
            expect(overDone()).toBe(false)
            recorder.append([snapshot(3, 2)])
            await over
            expect(f.state()).toMatchObject({ status: 'paused', line: 2, stepIndex: 3, recordingComplete: false })
            await f.session.seek(1)
            const out = f.session.command('stepOut')
            await out
            expect(f.state()).toMatchObject({ stepIndex: 3 })
            // From main no lower-depth snapshot has arrived yet.
            const outer = f.session.command('stepOut'),
                outerDone = await pending(outer)
            recorder.append([snapshot(4, 3)])
            await new Promise((resolve) => setTimeout(resolve, 0))
            expect(outerDone()).toBe(false)
            recorder.append([{ ...snapshot(5, 0, 0), reason: 'exited', exitCode: 0 }])
            await outer
            expect(f.state()).toMatchObject({ status: 'exited', stepIndex: 5 })
        } finally {
            await f.session.dispose()
        }
    })
    it('does not report missing cursor/breakpoint targets until recording ends, and cancels superseded waits', async () => {
        const f = await fixture()
        try {
            const cursor = f.session.runToCursor(file, 9),
                cursorDone = await pending(cursor)
            recorder.append([snapshot(1, 2)])
            await new Promise((resolve) => setTimeout(resolve, 0))
            expect(cursorDone()).toBe(false)
            await f.session.seek(0)
            await cursor
            const future = f.session.seek(100),
                futureDone = await pending(future)
            await f.session.command('stepIn')
            await future
            expect(futureDone()).toBe(true)
            expect(f.state()).toMatchObject({ stepIndex: 1 })
            const continuing = f.session.command('continue'),
                continueDone = await pending(continuing)
            recorder.append([snapshot(2, 3)])
            await new Promise((resolve) => setTimeout(resolve, 0))
            expect(continueDone()).toBe(false)
            recorder.finish({ snapshots: [], ended: false, elapsedMs: 5, limited: 'steps' })
            // Avoid invoking the mocked native live tail: cancel immediately after
            // recording ends, while the waiter is still queued for notification.
            await f.session.seek(0)
            await continuing
            expect(f.state()).toMatchObject({ stepIndex: 0, recordingComplete: true, mode: 'live' })
        } finally {
            await f.session.dispose()
        }
    })
})
