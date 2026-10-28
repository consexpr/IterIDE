import { createReadStream, promises as fs } from 'node:fs'

/** Decode only the requested prefix, plus one character to detect truncation. */
export async function previewFile(
    file: string | undefined,
    limit: number
): Promise<{ text: string; size: number; truncated: boolean }> {
    if (!file) return { text: '', size: 0, truncated: false }
    const size = await fs.stat(file).then(
        (s) => s.size,
        (e: NodeJS.ErrnoException) => {
            if (e.code === 'ENOENT') return 0
            throw e
        }
    )
    const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 100_000
    if (!size) return { text: '', size, truncated: false }
    let text = ''
    const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 4096 })
    try {
        for await (const chunk of stream) {
            text += chunk as string
            if (text.length > max) break
        }
    } finally {
        stream.destroy()
    }
    return { text: text.slice(0, max), size, truncated: text.length > max }
}
