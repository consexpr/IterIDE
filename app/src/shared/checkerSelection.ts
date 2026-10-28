import type { CheckerRef, JudgeMode, ProblemConfig, ProblemSettingsPatch } from './problem'

/** Old SPJ configs may have no file yet. Keep that choice visible until explicitly changed. */
export function selectedCheckerKind(problem: ProblemConfig): CheckerRef['kind'] {
    return problem.mode === 'spj' && !problem.grader ? 'custom' : problem.checker.kind
}

/** Stored mode ids remain compatible; the UI groups all non-interactive built-ins together. */
export function normalRunMode(problem: ProblemConfig, checker = problem.checker): JudgeMode {
    if (problem.grader || problem.mode === 'grader') return 'grader'
    return checker.kind === 'custom' ? 'spj' : 'standard'
}

/** Change the comparator and its legacy mode atomically, preserving compilation and communication. */
export function checkerSettingsPatch(problem: ProblemConfig, checker: CheckerRef): ProblemSettingsPatch {
    const next = { ...problem.checker, ...checker }
    // Selecting another file starts with its own protocol defaults, not the previous file's arguments.
    if (Object.hasOwn(checker, 'path')) {
        next.relativeTo = checker.relativeTo
        next.args = checker.args
    }
    if (checker.kind === 'builtin' && checker.builtin !== undefined && !Object.hasOwn(checker, 'value'))
        next.value = undefined
    return {
        mode: ['standard', 'spj', 'grader'].includes(problem.mode) ? normalRunMode(problem, next) : problem.mode,
        checker: next
    }
}

/** Keep inactive choices saved, but do not load their files or add their include directories. */
export function activeJudgeTools(
    problem: Pick<ProblemConfig, 'mode' | 'checker' | 'interactor'>
): (Pick<CheckerRef, 'path' | 'args' | 'relativeTo'> & { files?: string[] })[] {
    if (problem.mode === 'interactive') return problem.interactor ? [problem.interactor] : []
    const checker = problem.checker.kind === 'custom' ? [problem.checker] : []
    if (['standard', 'spj', 'grader'].includes(problem.mode)) return checker
    return [...checker, ...(problem.interactor ? [problem.interactor] : [])]
}

export function runModeChoice(problem: ProblemConfig): JudgeMode {
    return ['standard', 'spj', 'grader'].includes(problem.mode) ? 'standard' : problem.mode
}
