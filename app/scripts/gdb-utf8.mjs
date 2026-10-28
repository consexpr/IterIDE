import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NtExecutable, NtExecutableResource } from 'pe-library'

// This compatibility image is derived from the unsigned GDB in the pinned WinLibs
// 14.2.0posix-12.0.0-ucrt-r3 archive. The upstream archive checksum stays unchanged.
export const GDB_UTF8 = Object.freeze({
    version: 1,
    upstreamSha256: 'a2083e6554fdc8f9df1fbdf4c68ebfc03b1029779aa8d3b0c49206898ff0e867',
    patchedSha256: 'ae6e9ba253f912d80244ca0e427d08a9a2548efde1601281dad82bd65780236a'
})

export const UTF8_MANIFEST =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<assembly manifestVersion="1.0" xmlns="urn:schemas-microsoft-com:asm.v1">' +
    '<application><windowsSettings>' +
    '<activeCodePage xmlns="http://schemas.microsoft.com/SMI/2019/WindowsSettings">UTF-8</activeCodePage>' +
    '</windowsSettings></application></assembly>\n'

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const resourcesOf = (resources) =>
    resources.entries
        .map(({ type, id, lang, codepage, bin }) =>
            JSON.stringify([type, id, lang, codepage, digest(Buffer.from(bin))])
        )
        .sort()

/** Only the exact upstream image or our exact verified derivative is accepted. */
export function addGdbUtf8Manifest(bytes) {
    const actual = digest(bytes)
    if (actual === GDB_UTF8.patchedSha256) return { bytes, applied: false }
    if (actual !== GDB_UTF8.upstreamSha256) {
        throw new Error(`Unknown bundled GDB SHA-256: ${actual}. Refusing to change an unverified executable.`)
    }
    // pe-library rejects signed images by default; never strip an Authenticode signature.
    const executable = NtExecutable.from(bytes)
    const resources = NtExecutableResource.from(executable)
    if (resources.entries.some((entry) => entry.type === 24))
        throw new Error('Bundled GDB already has an unknown manifest')
    const original = resourcesOf(resources)
    resources.entries.push({
        type: 24,
        id: 1,
        lang: 1033,
        codepage: 65001,
        bin: Uint8Array.from(Buffer.from(UTF8_MANIFEST, 'utf8')).buffer
    })
    resources.outputResource(executable)
    const patched = Buffer.from(executable.generate())
    const verified = NtExecutableResource.from(NtExecutable.from(patched))
    const manifests = verified.entries.filter((entry) => entry.type === 24)
    if (
        manifests.length !== 1 ||
        Buffer.from(manifests[0].bin).toString('utf8') !== UTF8_MANIFEST ||
        JSON.stringify(resourcesOf({ entries: verified.entries.filter((entry) => entry.type !== 24) })) !==
            JSON.stringify(original) ||
        digest(patched) !== GDB_UTF8.patchedSha256
    ) {
        throw new Error('GDB UTF-8 compatibility image failed verification; the original executable was not changed')
    }
    return { bytes: patched, applied: true }
}

/** Atomic replacement leaves a usable original in place if preparation or writing fails. */
export async function ensureGdbUtf8(toolchainRoot) {
    const file = path.join(toolchainRoot, 'bin', 'gdb.exe')
    const result = addGdbUtf8Manifest(await readFile(file))
    if (result.applied) {
        const temporary = `${file}.iter-utf8-${randomUUID()}.tmp`
        try {
            await writeFile(temporary, result.bytes, { flag: 'wx', mode: (await stat(file)).mode })
            await rename(temporary, file)
        } finally {
            await rm(temporary, { force: true })
        }
    }
    return { ...GDB_UTF8, applied: result.applied }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const target = process.argv[2]
    if (!target) {
        console.error('Usage: node scripts/gdb-utf8.mjs <toolchain-root>')
        process.exitCode = 1
    } else
        ensureGdbUtf8(path.resolve(target)).then(
            (result) => console.log(JSON.stringify(result)),
            (error) => {
                console.error(error.message)
                process.exitCode = 1
            }
        )
}
