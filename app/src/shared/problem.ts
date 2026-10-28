// Each source owns one identity-backed problem in the application store.
// Linked datasets and source-relative tools keep the source directory as their path anchor.

/** Built-in mode ids; plugins may register any other non-empty id (see docs/judge-modes.md). */
export type JudgeMode = 'standard' | 'spj' | 'interactive' | 'grader' | (string & {})

/** How whitespace is treated; combined with a CheckerValue, which decides when two tokens are equal. */
export type CheckerLayout =
    | 'tokens' // whitespace-insensitive token compare (default, like most OJs)
    | 'lines' // ignore trailing spaces / trailing blank lines
    | 'exact' // identical after newline normalisation

export type CheckerValue =
    | 'text' // tokens must be identical
    | 'float4'
    | 'float6'
    | 'float9' // absolute-or-relative error
    | 'yesno' // case-insensitive YES/NO tokens

export const CHECKER_LAYOUTS: readonly CheckerLayout[] = ['tokens', 'lines', 'exact']
export const CHECKER_VALUES: readonly CheckerValue[] = ['text', 'float4', 'float6', 'float9', 'yesno']

/** Layouts, plus the older combined ids ('float6' meant "tokens + float 1e-6"), which are still read. */
export type BuiltinChecker = CheckerLayout | Exclude<CheckerValue, 'text'>

/** Splits a stored comparator into its two independent choices. */
export function resolveBuiltin(
    builtin: BuiltinChecker | undefined,
    value?: CheckerValue
): { layout: CheckerLayout; value: CheckerValue } {
    const legacy = CHECKER_VALUES.includes(builtin as CheckerValue) ? (builtin as CheckerValue) : undefined
    const layout = CHECKER_LAYOUTS.includes(builtin as CheckerLayout) ? (builtin as CheckerLayout) : 'tokens'
    return { layout, value: value && CHECKER_VALUES.includes(value) ? value : (legacy ?? 'text') }
}

export interface CheckerRef {
    /** Chooses the active checker. Inactive built-in rules and custom file settings are retained for switching back. */
    kind: 'builtin' | 'custom'
    builtin?: BuiltinChecker
    /** How equal tokens are decided; omitted means 'text'. */
    value?: CheckerValue
    /** Custom checker source (.cpp, testlib-style) or executable; path base is selected by relativeTo. */
    path?: string
    /** Omitted: relative to the managed problem directory; folder imports use the solution directory. */
    relativeTo?: 'source'
    /**
     * Argument template for custom checkers. Default testlib order: `{input} {output} {answer}`.
     * Placeholders: {input} {output} {answer} {score?}. Lets Lemon/Cena/Arbiter style checkers work.
     */
    args?: string
}

export interface FileIOConfig {
    enabled: boolean
    /** Explicit manual IO survives code without freopen (e.g. fstream). Missing in older versions. */
    origin?: 'freopen' | 'manual'
    /** File name the program reads, e.g. `foo.in`. */
    input: string
    /** File name the program writes, e.g. `foo.out`. */
    output: string
}

export interface InteractorRef {
    path: string
    args?: string
    relativeTo?: 'source'
    /** Additional C++ translation units and headers, anchored like path. */
    files?: string[]
}

export interface JudgeSourceFile {
    name: string
    code: string
}

export interface TestCaseMeta {
    id: string // stable id, also file stem inside tests/
    name: string // display name (e.g. original file name "sample1")
    enabled: boolean
    /** Missing/true compares against the saved answer; false only runs and captures output. */
    compareOutput?: boolean
    /** true when the case came from the statement (samples). Purely informational. */
    sample?: boolean
    /** Per-case time limit override in ms. */
    timeLimit?: number
    /**
     * Import provenance for deduplication only. Input and answer bytes are always cached locally.
     */
    link?: { input: string; answer?: string }
}

export interface ProblemConfig {
    version: 1
    title: string
    url?: string
    /** Free-form tags; plugins may use them (e.g. `luogu:P1001`). */
    tags?: string[]
    timeLimit: number // ms
    memoryLimit: number // MiB
    mode: JudgeMode
    /** Options of the active mode (free-form JSON owned by the mode plugin). */
    modeOptions?: Record<string, unknown>
    checker: CheckerRef
    /** Interactor source/executable; path base follows CheckerRef.relativeTo. Args `{input} {output} {answer}`. */
    interactor?: InteractorRef
    /**
     * Function-style interaction (NOI/IOI grader): `sources` are compiled and linked together with the
     * solution, `includeDirs` are added with -I (where e.g. perm.h lives). Paths relative to the source
     * file's directory. Output is then judged by the normal checker / comparison.
     */
    grader?: { sources: string[]; includeDirs?: string[] }
    fileIO: FileIOConfig
    /** Extra compile flags appended to the global ones for this problem only. */
    extraFlags?: string
    /** Header search roots owned by this problem, relative to its cache directory. */
    cachedIncludes?: string[]
    cachedSourceKey?: string
    cachedHeaders?: Record<string, string>
    cachedRuntime?: Record<string, string>
    tests: TestCaseMeta[]
}

/** Settings changes never carry a stale copy of the test collection. */
export type ProblemSettingsPatch = Partial<Omit<ProblemConfig, 'version' | 'tests'>>
/** Editable metadata only; identity, linked paths and file contents have separate operations. */
export type TestMetaPatch = Partial<Pick<TestCaseMeta, 'name' | 'enabled' | 'sample' | 'timeLimit' | 'compareOutput'>>

/** A test case with its content loaded (content may be truncated for display). */
export interface TestCaseData extends TestCaseMeta {
    /** false means only metadata is loaded; request readTest before editing the content. */
    previewLoaded?: boolean
    input: string
    answer: string
    /** Sizes in bytes of the on-disk files; content is truncated when larger than the display limit. */
    inputSize: number
    answerSize: number
    truncated: boolean
}

export function defaultProblem(title: string): ProblemConfig {
    return {
        version: 1,
        title,
        timeLimit: 1000,
        memoryLimit: 512,
        mode: 'standard',
        checker: { kind: 'builtin', builtin: 'tokens' },
        fileIO: { enabled: false, input: `${title}.in`, output: `${title}.out` },
        tests: []
    }
}
