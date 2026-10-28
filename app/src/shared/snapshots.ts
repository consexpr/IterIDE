/** A manual code checkpoint belonging to one source file's persistent identity. */
export interface CodeSnapshot {
    id: string
    /** Empty until renamed; the UI uses the creation time instead of a default label. */
    name: string
    createdAt: number
    bytes: number
    lines: number
}

export interface SnapshotContent extends CodeSnapshot {
    code: string
}
