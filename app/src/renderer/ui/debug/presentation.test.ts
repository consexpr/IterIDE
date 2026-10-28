import { describe, expect, it } from 'vitest'
import type { DebugState } from '../../../shared/debug'
import { recordedState, recordingNotice } from './presentation'

const paused: DebugState = {
    status: 'paused',
    mode: 'live',
    totalSteps: 590,
    stepIndex: 100,
    frame: 0,
    reason: 'seek',
    canStepBack: true,
    recordingComplete: true,
    recordingEnded: false,
    recordingMs: 30000,
    recordingLimit: 'time',
    recordingLimits: { maxSteps: 20000, maxDurationMs: 30000 }
}

describe('debug history presentation', () => {
    it('keeps recorded history browseable when automatic recording reaches a limit', () => {
        expect(recordedState(paused)).toBe(paused)
        expect(recordingNotice(paused)).toContain('30 秒上限')
        expect(recordingNotice(paused)).toContain('590 步仍可回放')
        expect(recordingNotice(paused)).toContain('实时调试')
    })

    it('keeps the timeline mounted during native execution and after exit', () => {
        expect(recordedState({ ...paused, status: 'running' })).not.toBeNull()
        const exited = {
            ...paused,
            status: 'exited',
            exitCode: 0,
            stdout: '',
            stderr: '',
            recordingEnded: true
        } as DebugState
        expect(recordedState(exited)).not.toBeNull()
        expect(recordingNotice(exited)).toContain('程序已结束')
    })

    it('explains recording failure without claiming the program finished', () => {
        const failed = { ...paused, mode: 'replay', recordingError: 'GDB 已关闭' } as DebugState
        expect(recordedState(failed)).not.toBeNull()
        expect(recordingNotice(failed)).toContain('GDB 已关闭')
        expect(recordingNotice(failed)).not.toContain('程序已结束')
    })

    it('distinguishes resource stops from a time or step limit', () => {
        expect(recordingNotice({ ...paused, resourceLimit: 'nodes' })).toContain('变量节点达到上限，程序已停止')
        expect(recordingNotice({ ...paused, recordingLimit: 'steps' })).toContain('20000 步上限')
    })

    it('does not create invalid sliders for an empty or malformed history', () => {
        expect(recordedState({ status: 'idle' })).toBeNull()
        expect(recordedState({ ...paused, totalSteps: 0 })).toBeNull()
        expect(recordedState({ ...paused, totalSteps: NaN })).toBeNull()
        expect(recordingNotice({ status: 'starting' })).toBeNull()
    })
})
