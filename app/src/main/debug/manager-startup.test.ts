import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Breakpoint, DebugStartRequest } from '../../shared/debug'
import type { ToolchainSettings } from '../../shared/judge'
import type { JudgeEngine } from '../judge/engine'
import type { DebugBuild } from './build'

const state = vi.hoisted(() => ({
    build: vi.fn(),
    remove: vi.fn(async () => {}),
    release: vi.fn(),
    sessions: [] as { points: Map<string, Breakpoint[]> }[]
}))
vi.mock('./build', () => ({ buildDebug: state.build, removeBuild: state.remove }))
vi.mock('../problem/store', () => ({ acquireProblemLease: async () => state.release }))
vi.mock('./session', () => ({
    DebugSession: class {
        points = new Map<string, Breakpoint[]>()
        constructor(build: DebugBuild, request: DebugStartRequest) {
            this.points.set(
                build.sourcePath,
                request.breakpoints.map((bp) => ({ ...bp }))
            )
            state.sessions.push(this)
        }
        async start() {}
        async dispose() {}
        async setBreakpoints(file: string, points: Breakpoint[]) {
            this.points.set(
                file,
                points.map((bp) => ({ ...bp }))
            )
        }
        async breakpoints() {
            return [...this.points].flatMap(([file, points]) => points.map((bp) => ({ ...bp, file })))
        }
    }
}))
import { DebugManager } from './manager'

describe('breakpoint edits while a debug build is pending', () => {
    it('retains the latest main/header breakpoints through compilation, including deleting the original breakpoint', async () => {
        state.sessions.length = 0
        state.build.mockReset()
        state.release.mockClear()
        const sourcePath = path.resolve('pending-debug.cpp'),
            header = path.resolve('pending-debug.h')
        const original: Breakpoint[] = [{ line: 49, enabled: true }]
        let compiled!: (build: DebugBuild) => void
        state.build.mockReturnValueOnce(
            new Promise<DebugBuild>((resolve) => {
                compiled = resolve
            })
        )
        const manager = new DebugManager(
            {} as JudgeEngine,
            () => ({}) as ToolchainSettings,
            () => {}
        )
        const starting = manager.start({
            sourcePath,
            source: 'int main() {}',
            breakpoints: original,
            stopAtEntry: false
        })
        try {
            await vi.waitFor(() => expect(state.build).toHaveBeenCalledTimes(1))
            await manager.setBreakpoints(sourcePath, [{ line: 50, enabled: true, condition: 'T > 0' }])
            await manager.setBreakpoints(header, [{ line: 12, enabled: true }])
            await manager.setBreakpoints(sourcePath, [])
            compiled({
                sourcePath,
                sourceFiles: [sourcePath, header],
                dir: path.resolve('unused-debug-build')
            } as DebugBuild)
            await starting
            expect(await manager.breakpoints()).toEqual([{ file: header, line: 12, enabled: true }])
            expect(original).toEqual([{ line: 49, enabled: true }])
        } finally {
            compiled({ sourcePath, sourceFiles: [sourcePath], dir: path.resolve('unused-debug-build') } as DebugBuild)
            await starting
            await manager.dispose()
        }
    })

    it('snapshots initial breakpoints before the caller can mutate the start request during compilation', async () => {
        state.sessions.length = 0
        state.build.mockReset()
        const sourcePath = path.resolve('pending-debug.cpp'),
            points: Breakpoint[] = [{ line: 49, enabled: true }]
        let compiled!: (build: DebugBuild) => void
        state.build.mockReturnValueOnce(
            new Promise<DebugBuild>((resolve) => {
                compiled = resolve
            })
        )
        const manager = new DebugManager(
            {} as JudgeEngine,
            () => ({}) as ToolchainSettings,
            () => {}
        )
        const starting = manager.start({ sourcePath, source: 'int main() {}', breakpoints: points, stopAtEntry: false })
        try {
            await vi.waitFor(() => expect(state.build).toHaveBeenCalledTimes(1))
            points[0].line = 999
            compiled({ sourcePath, sourceFiles: [sourcePath], dir: path.resolve('unused-debug-build') } as DebugBuild)
            await starting
            expect(await manager.breakpoints()).toEqual([{ file: sourcePath, line: 49, enabled: true }])
        } finally {
            compiled({ sourcePath, sourceFiles: [sourcePath], dir: path.resolve('unused-debug-build') } as DebugBuild)
            await starting
            await manager.dispose()
        }
    })
})
