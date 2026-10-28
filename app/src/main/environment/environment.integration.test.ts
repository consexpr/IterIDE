import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { expect, it, vi } from 'vitest'
import { EnvironmentHealthService } from './manager'
import { defaultSettings } from '../../shared/settings'
import { configureToolchain } from '../toolchain'

it('checks real copied compiler, IO, GDB and clangd repeatedly without creating problem data', async () => {
    const tools = defaultSettings().toolchain
    const events: string[] = []
    const service = new EnvironmentHealthService(
        () => tools,
        'integration',
        (report) => events.push(report.status)
    )
    const before = (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith('iter-health-')).sort()
    const store = process.env.ITER_STORE
    const storeBefore = store ? (await fs.readdir(store).catch(() => [])).sort() : []
    try {
        const result = await service.start()
        expect(result.error).toBeUndefined()
        expect(result.checks, JSON.stringify(result)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: 'compile', status: 'passed' }),
                expect.objectContaining({ id: 'run', status: 'passed' }),
                expect.objectContaining({ id: 'debug', status: 'passed' }),
                expect.objectContaining({ id: 'completion', status: 'passed' })
            ])
        )
        tools.compiler = path.join(os.tmpdir(), 'definitely-missing-health-compiler.exe')
        const failed = await service.start()
        expect(failed.checks[0].status).toBe('failed')
        expect(failed.checks[1].status).toBe('skipped')
        expect(failed.checks[2].status).toBe('failed')
        expect(failed.checks[3].status).toBe('failed')
        expect(events.filter((status) => status === 'complete')).toHaveLength(2)
        expect((await fs.readdir(os.tmpdir())).filter((name) => name.startsWith('iter-health-')).sort()).toEqual(before)
        if (store) expect((await fs.readdir(store).catch(() => [])).sort()).toEqual(storeBefore)
    } finally {
        await service.dispose()
    }
}, 60_000)

it('can cancel actual compiler work and run again after cancellation', async () => {
    const tools = defaultSettings().toolchain
    const service = new EnvironmentHealthService(
        () => tools,
        'integration',
        () => {}
    )
    try {
        const first = service.start()
        await vi.waitFor(() => expect(service.state().checks[0].status).toBe('running'))
        await service.cancel()
        expect((await first).status).toBe('cancelled')
        const next = await service.start()
        expect(
            next.checks.every((check) => check.status === 'passed'),
            JSON.stringify(next)
        ).toBe(true)
    } finally {
        await service.dispose()
        configureToolchain(path.resolve('resources/toolchain'))
    }
}, 60_000)
