import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TestResult } from '../../shared/judge'
import { JudgeProgressBatch } from './judgeProgress'

afterEach(() => vi.useRealTimers())

describe('judge progress batching', () => {
    it('commits a thousand test updates once and retains each latest result', () => {
        vi.useFakeTimers()
        const commit = vi.fn()
        const batch = new JudgeProgressBatch(commit)
        for (let index = 0; index < 1000; index++) {
            batch.enqueue('run', { testId: String(index), verdict: 'RUNNING' } as TestResult)
            batch.enqueue('run', { testId: String(index), verdict: 'AC' } as TestResult)
        }
        expect(commit).not.toHaveBeenCalled()
        vi.advanceTimersByTime(16)
        expect(commit).toHaveBeenCalledTimes(1)
        const results = commit.mock.calls[0][1]
        expect(Object.keys(results)).toHaveLength(1000)
        expect(Object.values(results).every((result: any) => result.verdict === 'AC')).toBe(true)
    })

    it('flushes final results before a terminal event without consuming another run', () => {
        vi.useFakeTimers()
        const commit = vi.fn()
        const batch = new JudgeProgressBatch(commit)
        batch.enqueue('old', { testId: '1', verdict: 'WA' } as TestResult)
        batch.enqueue('new', { testId: '1', verdict: 'AC' } as TestResult)
        batch.flush('old')
        expect(commit).toHaveBeenCalledExactlyOnceWith(
            'old',
            expect.objectContaining({ '1': expect.objectContaining({ verdict: 'WA' }) })
        )
        vi.advanceTimersByTime(16)
        expect(commit).toHaveBeenLastCalledWith(
            'new',
            expect.objectContaining({ '1': expect.objectContaining({ verdict: 'AC' }) })
        )
        expect(commit).toHaveBeenCalledTimes(2)
    })
})
