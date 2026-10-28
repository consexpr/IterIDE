import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { AppSettings } from '../../shared/settings'
import { effectiveFormatStyle } from '../format/style'

/** A transient document uses the same resolved config as standalone formatting,
 * including project styles, without writing to the user's workspace. */
export class FormattingDocuments {
    private readonly pending = new Map<number | string, { uri: string; directory: string }>()
    private readonly abort = new AbortController()

    async prepare(
        id: number | string,
        uri: string,
        settings: AppSettings
    ): Promise<{ uri: string; temporary: boolean }> {
        const sourcePath = fileURLToPath(uri)
        const style = await effectiveFormatStyle(sourcePath, settings, undefined, this.abort.signal)
        this.abort.signal.throwIfAborted()
        const directory = await mkdtemp(path.join(os.tmpdir(), 'iter-format-'))
        try {
            await writeFile(path.join(directory, '.clang-format'), style, 'utf8')
            this.abort.signal.throwIfAborted()
            // clang-format uses the source filename to recognize/sort its main header.
            const temporary = pathToFileURL(path.join(directory, path.basename(sourcePath))).href
            this.pending.set(id, { uri: temporary, directory })
            return { uri: temporary, temporary: true }
        } catch (error) {
            await rm(directory, { recursive: true, force: true })
            throw error
        }
    }

    finish(id: number | string): string | undefined {
        const entry = this.pending.get(id)
        if (!entry) return undefined
        this.pending.delete(id)
        void rm(entry.directory, { recursive: true, force: true }).catch(() => {})
        return entry.uri
    }

    cancel(): void {
        this.abort.abort()
    }

    async dispose(): Promise<void> {
        this.cancel()
        const entries = [...this.pending.values()]
        this.pending.clear()
        await Promise.all(entries.map((entry) => rm(entry.directory, { recursive: true, force: true })))
    }
}
