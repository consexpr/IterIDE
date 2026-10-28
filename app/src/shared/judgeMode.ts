// Judge modes are plugins (built-in: standard, spj, interactive, grader). The UI never hard-codes a
// mode: it renders whatever the active mode describes (info bar) and offers what modes are installed.

export interface ModeBadge {
    /** Short label, e.g. "SPJ", "交互库", "文件 IO". */
    label: string
    /** Value next to the label, e.g. "checker.cpp", "1 s · 512 MB". */
    value?: string
    /** Absolute path when the badge is about a file (the UI can open / reveal it). */
    file?: string
    /** `error`: e.g. the checker file is missing; `warn`: e.g. testlib.h not found next to it. */
    tone?: 'normal' | 'warn' | 'error'
    /** Hover text with details. */
    detail?: string
}

/** What the tests-panel info bar shows for one source file. */
export interface JudgeModeInfo {
    modeId: string
    modeName: string
    badges: ModeBadge[]
}

export interface JudgeModeSummary {
    id: string
    name: string
    /** `builtin` or the id of the plugin that registered it. */
    source: string
    description?: string
}
