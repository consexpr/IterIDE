/** One input/answer pair detected inside a folder or archive. */
export interface DetectedPair {
    /** Display name, e.g. "1", "sample2", "subtask1/03". */
    name: string
    /** Path of the input entry (file path, or archive-internal path). */
    input: string
    /** Path of the answer entry; undefined when no answer file was found. */
    answer?: string
}

export interface ImportPreview {
    /** Source the user dropped (folder or archive path). */
    source: string
    pairs: DetectedPair[]
    /** Files that look like test data but could not be paired. */
    unmatched: string[]
    /** Files that look like checkers / interactors / testlib.h and could be attached. */
    extras: { path: string; role: 'checker' | 'interactor' | 'testlib' | 'validator' | 'generator' | 'solution' }[]
    /** Human-readable notes about decisions taken (e.g. "both .ans and .out found, used .ans"). */
    notes: string[]
}

export interface ImportRequest {
    sourcePath: string // .cpp the problem belongs to
    preview: ImportPreview
    /** Replace existing tests instead of appending. */
    replace: boolean
    /** Also attach detected checker/interactor. */
    attachExtras: boolean
}

/** A folder that holds one problem's files (exam layout: data + checker/grader + the user's code). */
export interface ProblemFolderPreview {
    dir: string
    /** Problem name, usually the folder name (`bot`, `perm`). */
    name: string
    /** Candidate user solutions in the folder (absolute .cpp paths; checker/grader/template excluded). */
    sources: string[]
    /** A `template_*.cpp` / `*_template.cpp` to start a new solution from. */
    template?: string
    /** Folder previews use absolute data paths. */
    pairs: DetectedPair[]
    unmatched: string[]
    notes: string[]
    checker?: string
    interactor?: string
    grader?: { sources: string[]; headers: string[] }
    /** Judge mode the detection plugins chose for this folder, and the config they would set. */
    mode?: string
    modeConfig?: Record<string, unknown>
    /** Solution that already has a ITER problem bound to this folder's data, if any. */
    boundSource?: string
}

/** `problem`: the folder itself is a problem. `contest`: each subfolder is one. */
export interface FolderImportPreview {
    kind: 'problem' | 'contest' | 'none'
    root: string
    problems: ProblemFolderPreview[]
}

export interface ProblemFolderImportRequest {
    problem: ProblemFolderPreview
    /** Existing solution to bind, or a new path to create (from `template` if present, else the app template). */
    sourcePath: string
    /** Initial code when sourcePath doesn't exist yet. */
    initialCode?: string
    /** Reference data files in place (default) instead of copying them into .iter. */
    link: boolean
    replaceTests: boolean
}
