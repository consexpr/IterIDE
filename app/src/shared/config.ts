/** Counts are regular files restored in each user configuration directory. */
export interface ImportSummary {
    settings: boolean
    themes: number
    fonts: number
    plugins: number
    backupDir: string
}
