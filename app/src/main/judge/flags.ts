import path from 'node:path'
import { loadProblem, problemDir } from '../problem/store'
import { splitArgs } from '../toolchain/args'
import { resourceContext } from '../problem/resourceRuntime'
import { getMode, type ModeBuildPlan, type ModeProblem } from './modes/registry'

export async function buildPlanFor(sourcePath: string, problem: ModeProblem): Promise<ModeBuildPlan> {
    sourcePath = path.resolve(sourcePath)
    const base = path.dirname(sourcePath)
    const mode = getMode(problem)
    const plan =
        (await mode.build?.({ problem, sourcePath, sourceDir: base, problemDir: problemDir(sourcePath) })) ?? {}
    return {
        sourceRuntime: Object.fromEntries(
            Object.entries(problem.cachedRuntime ?? {}).map(([name, target]) => [
                name,
                path.resolve(problemDir(sourcePath), target)
            ])
        ),
        sourceHeaders: Object.fromEntries(
            Object.entries(problem.cachedHeaders ?? {}).map(([name, target]) => [
                name,
                path.resolve(problemDir(sourcePath), target)
            ])
        ),
        sources: [...new Set((plan.sources ?? []).map((file) => path.resolve(base, file)))],
        includeDirs: [
            ...new Set([
                ...(problem.cachedIncludes ?? []).map((dir) => path.resolve(problemDir(sourcePath), dir)),
                base,
                ...(plan.includeDirs ?? []).map((dir) => path.resolve(base, dir))
            ])
        ],
        flags: plan.flags ?? []
    }
}
/** Also used by debug builds; argument order matches the judge compiler invocation. */
export function planArgs(flags: string, problem: ModeProblem, plan: ModeBuildPlan): string[] {
    return [
        ...splitArgs(flags),
        ...splitArgs(problem.extraFlags ?? ''),
        ...(plan.flags ?? []),
        ...(plan.includeDirs ?? []).flatMap((dir) => ['-I', dir])
    ]
}
export async function compileArgsFor(sourcePath: string, flags: string): Promise<string[]> {
    const problem = await loadProblem(sourcePath)
    const plan = await buildPlanFor(sourcePath, problem)
    const resources = await resourceContext([sourcePath, ...(plan.sources ?? []), ...(plan.includeDirs ?? [])])
    return [
        ...planArgs(flags, problem, plan),
        ...resources.flags,
        ...resources.includeDirs.flatMap((dir) => ['-I', dir])
    ]
}
