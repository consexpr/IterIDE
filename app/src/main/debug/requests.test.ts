import { expect, it } from 'vitest'
import { debugBreakpoints, debugCommand, debugIndex, debugRequest, debugText } from './requests'

it.each([
    null,
    [],
    {},
    { sourcePath: 'main.cpp', source: '', breakpoints: null },
    { sourcePath: 7, source: '', breakpoints: [] },
    { sourcePath: 'main.cpp', source: '', breakpoints: [], recording: { maxSteps: Infinity } }
])('rejects malformed debug starts: %j', (value) => {
    expect(() => debugRequest(value)).toThrow('无效的调试参数')
})
it('snapshots valid data and preserves hit-condition verification semantics', () => {
    const breakpoints = [{ line: 4, enabled: true, hitCondition: -1 }]
    const request = debugRequest({ sourcePath: 'main.cpp', source: '', breakpoints, recording: { maxSteps: 1 } })
    breakpoints[0].line = 9
    expect(request.breakpoints).toEqual([{ line: 4, enabled: true, hitCondition: -1 }])
    expect(request.recording).toEqual({ maxSteps: 1 })
})
it('rejects invalid commands, references and indexes before navigation', () => {
    expect(() => debugCommand('next-instruction')).toThrow('command')
    expect(() => debugIndex(NaN, 'step')).toThrow('step')
    expect(() => debugIndex(-1, 'step')).toThrow('step')
    expect(() => debugText({}, 'reference')).toThrow('reference')
    expect(() => debugBreakpoints([{ line: 1, enabled: 'true' }])).toThrow('enabled')
    expect(() => debugBreakpoints(new Array(4097))).toThrow('breakpoints')
    expect(() => debugBreakpoints(new Array(2))).toThrow('breakpoints')
    expect(() => debugText('x'.repeat(16_385), 'expression')).toThrow('expression')
})
