import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
    state: {} as any,
    update: vi.fn(async () => ({})),
    flush: vi.fn(async () => {}),
    debugging: false
}))
vi.mock('../state/app', () => ({
    store: { get: () => fixture.state },
    toast: vi.fn(),
    activeFile: vi.fn(),
    isDebugging: () => fixture.debugging,
    updateFile: (path: string, change: any) => {
        fixture.state.files = fixture.state.files.map((file: any) =>
            file.path === path ? { ...file, ...(typeof change === 'function' ? change(file) : change) } : file
        )
    }
}))
vi.mock('./files', () => ({ reloadProblem: vi.fn() }))
vi.mock('./problemWrites', () => ({
    enqueueProblemSettings: vi.fn(),
    enqueueTestWrite: vi.fn(),
    flushProblemWrites: vi.fn(),
    saveProblemSettings: vi.fn(),
    testIsDeleting: () => false,
    withProblemMutation: (_path: string, action: (flush: () => Promise<void>) => Promise<void>) =>
        action(fixture.flush),
    withTestDeletion: vi.fn()
}))
beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    fixture.debugging = false
    const tests = [
        { id: '1', answer: 'saved answer' },
        { id: '2', answer: 'other answer' }
    ]
    fixture.state = {
        activePath: '/main.cpp',
        closing: false,
        debug: { path: null },
        files: [
            {
                path: '/main.cpp',
                problem: { tests },
                tests,
                results: { '1': { verdict: 'WA' }, '2': { verdict: 'AC' } },
                lastVerdict: 'WA'
            }
        ]
    }
    fixture.update.mockResolvedValue({})
    vi.stubGlobal('window', { iter: { problem: { updateTest: fixture.update } } })
})

describe('comparison toggle action', () => {
    it('persists only the selected policy, retains answers, and clears its stale result', async () => {
        const { setCompareOutput } = await import('./tests')
        await setCompareOutput('1', false)
        expect(fixture.flush).toHaveBeenCalledOnce()
        expect(fixture.update).toHaveBeenCalledWith('/main.cpp', '1', { compareOutput: false })
        expect(fixture.state.files[0]).toMatchObject({
            tests: [
                { id: '1', answer: 'saved answer', compareOutput: false },
                { id: '2', answer: 'other answer' }
            ],
            results: { '2': { verdict: 'AC' } },
            lastVerdict: null
        })
        expect(fixture.state.files[0].results['1']).toBeUndefined()
    })
    it('keeps the old comparison policy and result when saving fails', async () => {
        fixture.update.mockRejectedValueOnce(new Error('disk full'))
        const { setCompareOutput } = await import('./tests')
        await expect(setCompareOutput('1', false)).rejects.toThrow('disk full')
        expect(fixture.state.files[0].tests[0].compareOutput).toBeUndefined()
        expect(fixture.state.files[0].results['1'].verdict).toBe('WA')
    })
    it.each(['judge', 'terminal', 'debug'] as const)('blocks changes during %s', async (kind) => {
        if (kind === 'judge') fixture.state.files[0].runId = 'running'
        if (kind === 'terminal') fixture.state.files[0].terminalRunId = 'running'
        if (kind === 'debug') {
            fixture.state.debug.path = '/main.cpp'
            fixture.debugging = true
        }
        const { setCompareOutput } = await import('./tests')
        await expect(setCompareOutput('1', false)).rejects.toThrow('请先结束运行或调试')
        expect(fixture.update).not.toHaveBeenCalled()
    })
})
