import { promises as fs } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../../shared/settings'
import { EnvironmentHealthService, type EnvironmentProbes } from './manager'
import type { ProbeContext } from './probes'
import { formatEnvironmentHealth } from '../../shared/environment'

const good = (): EnvironmentProbes => ({
    compile: vi.fn(async (context) => {
        context.compiled = true
        return { summary: 'compiled' }
    }),
    run: vi.fn(async () => ({ summary: 'ran' })),
    debug: vi.fn(async () => ({ summary: 'debugged' })),
    completion: vi.fn(async () => ({ summary: 'completed' }))
})
describe('manual environment health lifecycle', () => {
    it('does not run on construction or state reads, then runs again with a fresh settings snapshot', async () => {
        const tools = defaultSettings().toolchain,
            probes = good(),
            notify = vi.fn()
        const service = new EnvironmentHealthService(() => tools, 'test', notify, probes)
        expect(service.state().status).toBe('idle')
        expect(probes.compile).not.toHaveBeenCalled()
        expect(notify).not.toHaveBeenCalled()
        const one = await service.start()
        expect(one.checks.every((check) => check.status === 'passed')).toBe(true)
        const directory = vi.mocked(probes.compile).mock.calls[0][0].directory
        await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
        tools.flags = '-std=c++20'
        const two = await service.start()
        expect(two.config?.flags).toBe('-std=c++20')
        expect(one.config?.flags).not.toBe(two.config?.flags)
        expect(two.revision).toBeGreaterThan(one.revision)
        expect(probes.compile).toHaveBeenCalledTimes(2)
        const state = service.state()
        state.checks[0].summary = 'mutated'
        expect(service.state().checks[0].summary).toBe('compiled')
        await service.dispose()
    })
    it('coalesces repeated start and cancels owned work before permitting a new run', async () => {
        const probes = good()
        let entered: (() => void) | undefined
        const ready = new Promise<void>((resolve) => {
            entered = resolve
        })
        let context!: ProbeContext
        probes.compile = vi.fn(async (current) => {
            context = current
            entered?.()
            await new Promise<void>((_resolve, reject) =>
                current.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
            )
            return { summary: 'unused' }
        })
        const service = new EnvironmentHealthService(
            () => defaultSettings().toolchain,
            'test',
            () => {},
            probes
        )
        const first = service.start()
        expect(service.start()).toBe(first)
        await ready
        await service.cancel()
        expect((await first).status).toBe('cancelled')
        expect(context.signal.aborted).toBe(true)
        expect(probes.run).not.toHaveBeenCalled()
        await expect(fs.stat(context.directory)).rejects.toMatchObject({ code: 'ENOENT' })
        Object.assign(probes, good())
        expect((await service.start()).checks.every((check) => check.status === 'passed')).toBe(true)
        await service.dispose()
        await expect(service.start()).rejects.toThrow('关闭')
    })
    it('skips run after failed compilation but still checks debugger and completion independently', async () => {
        const probes = good()
        probes.compile = vi.fn(async () => {
            throw new Error('compiler missing')
        })
        probes.debug = vi.fn(async () => ({ summary: 'no Python', warning: true }))
        const service = new EnvironmentHealthService(
            () => defaultSettings().toolchain,
            'test',
            () => {},
            probes
        )
        const report = await service.start()
        expect(report.checks.map((check) => check.status)).toEqual(['failed', 'skipped', 'warning', 'passed'])
        expect(probes.run).not.toHaveBeenCalled()
        const text = formatEnvironmentHealth(report)
        expect(text).toContain('compiler missing')
        expect(text).toContain('编译器路径')
        expect(text).toContain('no Python')
        expect(text).not.toContain('sync')
        await service.dispose()
    })
    it('cleans scratch and cancels pending probes when the application shuts down', async () => {
        const probes = good()
        let directory = ''
        probes.debug = vi.fn(async (context) => {
            directory = context.directory
            await new Promise<void>((_resolve, reject) =>
                context.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
            )
            return { summary: '' }
        })
        const service = new EnvironmentHealthService(
            () => defaultSettings().toolchain,
            'test',
            () => {},
            probes
        )
        const work = service.start()
        await vi.waitFor(() => expect(directory).not.toBe(''))
        expect(path.basename(directory).startsWith('iter-health-')).toBe(true)
        await service.dispose()
        expect((await work).status).toBe('cancelled')
        expect(probes.completion).not.toHaveBeenCalled()
        await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    })
})
