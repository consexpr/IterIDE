export interface UserSnippet {
    trigger: string
    body: string
    detail?: string
}

/** Passed as getSettings().completion (the UI stores this under editor.completion). */
export interface CompletionOptions {
    model: boolean
    showCompletionWhileInput: boolean
    minCharRequired: number
    sortByScope: boolean
    recordUsage: boolean
    showKeywords: boolean
    ignoreCase: boolean
    appendFunc: boolean
    hideSymbolsStartsWithUnderLine: boolean
    hideSymbolsStartsWithTwoUnderLine: boolean
    snippets: readonly UserSnippet[]
}

export const DEFAULT_COMPLETION_OPTIONS: Readonly<CompletionOptions> = {
    model: false,
    showCompletionWhileInput: true,
    minCharRequired: 1,
    sortByScope: true,
    recordUsage: true,
    showKeywords: true,
    ignoreCase: true,
    appendFunc: true,
    hideSymbolsStartsWithUnderLine: false,
    hideSymbolsStartsWithTwoUnderLine: true,
    snippets: []
}

export function completionOptions(options?: Partial<CompletionOptions>): CompletionOptions {
    const result = { ...DEFAULT_COMPLETION_OPTIONS, ...options }
    result.model = result.model === true
    result.minCharRequired = Number.isFinite(result.minCharRequired)
        ? Math.max(0, Math.floor(result.minCharRequired))
        : 1
    return result
}

// Language keywords, with no library names or application-specific weights.
export const CPP_KEYWORDS =
    'alignas alignof and and_eq asm auto bitand bitor bool break case catch char char8_t char16_t char32_t class compl concept const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept not not_eq nullptr operator or or_eq private protected public register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while xor xor_eq'.split(
        ' '
    )
