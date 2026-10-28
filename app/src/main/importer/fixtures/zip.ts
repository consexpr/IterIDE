import { writeFile } from 'node:fs/promises'
import { crc32, deflateRawSync } from 'node:zlib'

export interface ZipFixtureEntry {
    name: string | Buffer
    content?: string | Buffer
    flags?: number
    mode?: number
    extra?: Buffer
    method?: number
    corrupt?: boolean
}

/** Tiny fixture writer: supports raw legacy names, backslashes and Unix attributes. */
export async function writeZip(path: string, entries: ZipFixtureEntry[]): Promise<void> {
    const locals: Buffer[] = []
    const central: Buffer[] = []
    let offset = 0
    for (const entry of entries) {
        const name = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name)
        const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content ?? '')
        const method = entry.method ?? 8
        const compressed = method === 8 ? deflateRawSync(content) : content
        const flags = entry.flags ?? 0x800
        const extra = entry.extra ?? Buffer.alloc(0)
        const header = Buffer.alloc(30)
        header.writeUInt32LE(0x04034b50)
        header.writeUInt16LE(20, 4)
        header.writeUInt16LE(flags, 6)
        header.writeUInt16LE(method, 8)
        header.writeUInt32LE(crc32(content), 14)
        header.writeUInt32LE(compressed.length, 18)
        header.writeUInt32LE(content.length, 22)
        header.writeUInt16LE(name.length, 26)
        header.writeUInt16LE(extra.length, 28)
        const directory = Buffer.alloc(46)
        directory.writeUInt32LE(0x02014b50)
        directory.writeUInt16LE(0x0314, 4)
        directory.writeUInt16LE(20, 6)
        directory.writeUInt16LE(flags, 8)
        directory.writeUInt16LE(method, 10)
        directory.writeUInt32LE(crc32(content), 16)
        directory.writeUInt32LE(compressed.length, 20)
        directory.writeUInt32LE(content.length, 24)
        directory.writeUInt16LE(name.length, 28)
        directory.writeUInt16LE(extra.length, 30)
        directory.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38)
        directory.writeUInt32LE(offset, 42)
        central.push(directory, name, extra)
        const body = entry.corrupt ? Buffer.alloc(compressed.length, 0xff) : compressed
        locals.push(header, name, extra, body)
        offset += header.length + name.length + extra.length + compressed.length
    }
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50)
    end.writeUInt16LE(entries.length, 8)
    end.writeUInt16LE(entries.length, 10)
    end.writeUInt32LE(
        central.reduce((size, part) => size + part.length, 0),
        12
    )
    end.writeUInt32LE(offset, 16)
    await writeFile(path, Buffer.concat([...locals, ...central, end]))
}
