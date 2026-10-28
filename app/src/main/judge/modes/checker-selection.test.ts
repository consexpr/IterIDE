import { expect, it, vi } from 'vitest'
import { defaultProblem } from '../../../shared/problem'
import {
    checkerSettingsPatch,
    normalRunMode,
    runModeChoice,
    selectedCheckerKind
} from '../../../shared/checkerSelection'
import { getMode, type ModeContext, type ModeRunContext } from './registry'

it('switches an old SPJ to built-in comparison without preparing its previous checker', async () => {
    const problem = defaultProblem('main')
    problem.mode = 'spj'
    problem.checker = { kind: 'custom', path: 'old-checker.cpp' }
    Object.assign(problem, checkerSettingsPatch(problem, { kind: 'builtin', builtin: 'tokens' }))
    const mode = getMode(problem)
    const context = { problem, runner: vi.fn(async () => undefined), prepareTool: vi.fn() } as unknown as ModeContext
    const prepared = await mode.prepare!(context)
    const run = vi.fn(async () => ({ verdict: 'AC' }))
    await mode.run({ ...context, prepared, test: { compareOutput: true }, runShared: run } as unknown as ModeRunContext)
    expect(mode.id).toBe('standard')
    expect(context.prepareTool).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledWith({ runner: undefined, checker: undefined })
    expect(problem.checker.path).toBe('old-checker.cpp')
})

it.each(['standard', 'spj', 'grader'])('retains joint compilation while changing the checker from %s', (mode) => {
    const problem = { ...defaultProblem('task'), mode, grader: { sources: ['grader.cpp'], includeDirs: ['include'] } }
    const grader = problem.grader
    Object.assign(problem, checkerSettingsPatch(problem, { kind: 'custom', path: 'checker.cpp' }))
    expect(getMode(problem).id).toBe('grader')
    expect(problem.grader).toBe(grader)
    Object.assign(problem, checkerSettingsPatch(problem, { kind: 'builtin', builtin: 'lines', value: 'float6' }))
    expect(getMode(problem).id).toBe('grader')
    expect(problem.grader).toBe(grader)
    expect(runModeChoice(problem)).toBe('standard')
})

it('preserves interaction and plugin modes when attaching checker code', () => {
    const problem = { ...defaultProblem('task'), mode: 'interactive', interactor: { path: 'interactor.cpp' } }
    Object.assign(problem, checkerSettingsPatch(problem, { kind: 'custom', path: 'checker.cpp' }))
    expect(getMode(problem).id).toBe('interactive')
    expect(normalRunMode(problem)).toBe('spj')
    problem.mode = 'plugin-mode'
    expect(checkerSettingsPatch(problem, { kind: 'builtin' }).mode).toBe('plugin-mode')
})

it('shows an incomplete legacy SPJ as custom until the user selects built-in comparison', () => {
    const problem = { ...defaultProblem('task'), mode: 'spj' }
    expect(selectedCheckerKind(problem)).toBe('custom')
    Object.assign(problem, checkerSettingsPatch(problem, { kind: 'builtin', builtin: 'tokens' }))
    expect(selectedCheckerKind(problem)).toBe('builtin')
})
