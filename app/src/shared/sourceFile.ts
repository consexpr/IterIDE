export interface SourceWriteOptions {
    /** LF-normalized disk content last observed by the editor; null requires a new file. */
    expected?: string | null
    /** Only an explicit Save may ask to overwrite an external change. */
    confirmOverwrite?: boolean
}
