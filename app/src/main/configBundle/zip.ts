import { open } from 'node:fs/promises'
import { crc32, deflateRaw } from 'node:zlib'
import { promisify } from 'node:util'
import { limits } from './common'

export interface ZipSource {
    name: string
    data: Buffer
}
const compress = promisify(deflateRaw)

/** Small classic ZIP writer: UTF-8 names, CRC32, stored directories and deflated files. */
export async function writeZip(file: string, entries: Iterable<ZipSource> | AsyncIterable<ZipSource>): Promise<void> {
    const output = await open(file, 'wx')
    const central: Buffer[] = []
    let offset = 0,
        total = 0
    const write = async (data: Buffer): Promise<void> => {
        let written = 0
        while (written < data.length) written += (await output.write(data, written, data.length - written)).bytesWritten
        offset += data.length
        if (offset > limits.total) throw new Error('Config archive is too large')
    }
    try {
        for await (const entry of entries) {
            if (
                central.length >= limits.entries ||
                entry.data.length > limits.file ||
                (total += entry.data.length) > limits.total
            ) {
                throw new Error('Config archive exceeds size or entry limits')
            }
            const name = Buffer.from(entry.name, 'utf8')
            if (!name.length || name.length > 0xffff) throw new Error('Invalid ZIP filename length')
            const directory = entry.name.endsWith('/')
            // Compression can be substantial for test data/fonts; keep Electron's main loop responsive.
            const compressed = directory ? entry.data : await compress(entry.data)
            const checksum = crc32(entry.data)
            const local = Buffer.alloc(30)
            local.writeUInt32LE(0x04034b50)
            local.writeUInt16LE(20, 4)
            local.writeUInt16LE(0x800, 6)
            local.writeUInt16LE(directory ? 0 : 8, 8)
            local.writeUInt16LE(0x21, 12) // DOS date: 1980-01-01.
            local.writeUInt32LE(checksum, 14)
            local.writeUInt32LE(compressed.length, 18)
            local.writeUInt32LE(entry.data.length, 22)
            local.writeUInt16LE(name.length, 26)
            const header = Buffer.alloc(46)
            header.writeUInt32LE(0x02014b50)
            header.writeUInt16LE(20, 4)
            local.copy(header, 6, 4, 30)
            header.writeUInt32LE(directory ? 0x10 : 0, 38)
            header.writeUInt32LE(offset, 42)
            central.push(Buffer.concat([header, name]))
            await write(local)
            await write(name)
            await write(compressed)
        }
        const start = offset
        for (const header of central) await write(header)
        const end = Buffer.alloc(22)
        end.writeUInt32LE(0x06054b50)
        end.writeUInt16LE(central.length, 8)
        end.writeUInt16LE(central.length, 10)
        end.writeUInt32LE(offset - start, 12)
        end.writeUInt32LE(start, 16)
        await write(end)
        await output.sync()
    } finally {
        await output.close()
    }
}
