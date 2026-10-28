import type { CompileResult, TestResult, ToolchainSettings } from '../../../shared/judge'
import type { JudgeModeInfo, JudgeModeSummary } from '../../../shared/judgeMode'
import type { ProblemConfig, TestCaseMeta } from '../../../shared/problem'
import type { ProblemFolderPreview } from '../../../shared/importer'
import type { execute, ProcessResult } from '../process'
import { standardMode } from './builtin/standard'
import { spjMode } from './builtin/spj'
import { interactiveMode } from './builtin/interactive'
import { graderMode } from './builtin/grader'

export type ModeProblem = Omit<ProblemConfig, 'mode'> & { mode: string; modeOptions?: Record<string, unknown> }
export type Awaitable<T> = T | Promise<T>
type ProcessOptions = Parameters<typeof execute>[2]
export interface ModeFolder {
    /** Absolute folder path; files are sorted, relative direct entries. */
    dir: string
    files: readonly string[]
    /** Synchronous, bounded text peek; unavailable/non-text files return undefined. */
    peek(file: string): string | undefined
}
export interface ModeDetection {
    confidence: number
    /** Paths are relative to folder.dir. mode is supplied by the registry. */
    config?: Partial<ModeProblem>
    /** Existing importer attachments, also relative to folder.dir. */
    attachments?: Pick<ProblemFolderPreview, 'checker' | 'interactor' | 'grader'>
    excludeSources?: string[]
    /** When provided, restrict solution candidates to these files. */
    solutionFiles?: string[]
    notes?: string[]
}
export interface ModeBuildPlan {
    /** Managed local header paths for the live solution buffer. */
    sourceHeaders?: Record<string, string>
    sourceRuntime?: Record<string, string>
    /** Additional translation units and include directories; relative to sourceDir or absolute. */
    sources?: string[]
    includeDirs?: string[]
    /** Argument array appended after global flags and problem.extraFlags. */
    flags?: string[]
}
export interface ModePaths {
    problem: ModeProblem
    sourcePath: string
    sourceDir: string
    problemDir: string
}
export interface ModeContext extends ModePaths {
    toolchain: ToolchainSettings
    signal: AbortSignal
    /** Cached solution build using this mode's build plan; source is unsaved editor content. */
    compile(): Promise<CompileResult>
    /** Cached C++ helper build (local testlib.h, then bundled fallback), or existing executable. */
    prepareTool(file: string, relativeTo?: 'source', files?: string[]): Promise<string>
    runner(): Promise<string | undefined>
    /** execute through the --exec wrapper to suppress Windows crash dialogs. */
    execute(
        exe: string,
        args: string[],
        options?: Partial<Omit<ProcessOptions, 'signal' | 'runner' | 'nativeJob'>>
    ): Promise<ProcessResult>
    /** Creates a run-owned temporary directory, removed when the run finishes. */
    tempDir(): Promise<string>
}
export interface ModeCompileContext extends ModeContext {
    source: string
    debug: boolean
}
export interface ModeRunContext extends ModeContext {
    test: TestCaseMeta
    compiled: CompileResult
    /** Value returned by prepare, shared across tests; do not mutate it during parallel runs. */
    prepared: unknown
    dataPaths: { input: string; answer?: string }
    /** Existing resource-accounted, isolated runner and comparator path. */
    runShared(options?: { checker?: string; runner?: string }): Promise<TestResult>
    /** Existing isolated interactive piping path. */
    runInteractive(interactor: string): Promise<TestResult>
}
export interface ModeSettingField {
    key: string
    label: string
    type: 'text' | 'number' | 'select' | 'file'
    description?: string
    default?: string | number
    required?: boolean
    min?: number
    max?: number
    options?: { label: string; value: string }[]
}
/** Plain JavaScript objects are supported; no base class or privileged built-in dispatch. */
export interface JudgeModePlugin {
    id: string
    name: string
    description?: string
    settingsSchema?: ModeSettingField[]
    /** false serializes tests (e.g. interactive); default true. */
    parallel?: boolean
    detect(folder: ModeFolder): ModeDetection | undefined
    build?(context: ModePaths): Awaitable<ModeBuildPlan>
    /** Optional override, e.g. output-only returns ok:true without an executable. */
    compile?(context: ModeCompileContext): Awaitable<CompileResult>
    prepare?(context: ModeContext): Awaitable<unknown>
    run(context: ModeRunContext): Awaitable<TestResult>
    describe(problem: ModeProblem, sourcePath: string): Awaitable<JudgeModeInfo>
}

const registry = new Map<string, { source: string; mode: JudgeModePlugin }>()
export function registerMode(source: string, mode: JudgeModePlugin): void {
    if (
        typeof source !== 'string' ||
        !source.trim() ||
        !mode ||
        typeof mode.id !== 'string' ||
        !/^[a-zA-Z0-9][\w.-]*$/.test(mode.id) ||
        typeof mode.name !== 'string' ||
        !mode.name.trim()
    )
        throw new Error('Invalid judge mode id/name/source')
    for (const hook of ['detect', 'run', 'describe'] as const)
        if (typeof mode[hook] !== 'function') throw new Error(`Judge mode ${mode.id} requires ${hook}()`)
    for (const hook of ['build', 'compile', 'prepare'] as const)
        if (mode[hook] !== undefined && typeof mode[hook] !== 'function')
            throw new Error(`Judge mode ${mode.id}: ${hook} must be a function`)
    if (registry.has(mode.id)) throw new Error(`Judge mode already registered: ${mode.id}`)
    registry.set(mode.id, { source, mode })
}
export function unregisterSource(source: string): void {
    if (source === 'builtin') return
    for (const [id, entry] of registry) if (entry.source === source) registry.delete(id)
}
export function modeIdFor(problem: ModeProblem): string {
    if ((problem.mode === 'standard' || problem.mode === 'spj') && problem.grader) return 'grader'
    if (problem.mode === 'standard' && problem.checker.kind === 'custom') return 'spj'
    return problem.mode
}
export function getMode(problem: ModeProblem): JudgeModePlugin {
    const id = modeIdFor(problem),
        entry = registry.get(id)
    if (!entry) throw new Error(`评测模式「${id}」未安装，请安装提供此模式的插件`)
    return entry.mode
}
export function listModes(): JudgeModeSummary[] {
    return [...registry.values()].map(({ source, mode }) => ({
        id: mode.id,
        name: mode.name,
        source,
        ...(mode.description ? { description: mode.description } : {})
    }))
}
export function detectModes(folder: ModeFolder): { mode: JudgeModePlugin; detection: ModeDetection }[] {
    const matches: { mode: JudgeModePlugin; detection: ModeDetection }[] = []
    for (const { mode } of registry.values()) {
        const detection = mode.detect(folder)
        if (!detection) continue
        if (!Number.isFinite(detection.confidence) || detection.confidence < 0 || detection.confidence > 1)
            throw new Error(`Judge mode ${mode.id}: confidence must be in [0, 1]`)
        matches.push({ mode, detection })
    }
    return matches.sort((a, b) => b.detection.confidence - a.detection.confidence)
}

for (const mode of [standardMode, spjMode, interactiveMode, graderMode]) registerMode('builtin', mode)
