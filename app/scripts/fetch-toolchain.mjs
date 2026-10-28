import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import sevenZip from '7zip-bin'
import { ensureGdbUtf8 } from './gdb-utf8.mjs'

// Official release/checksum, checked on 2026-10-19. Never trust a runtime-fetched checksum.
// https://github.com/brechtsanders/winlibs_mingw/releases/tag/14.2.0posix-12.0.0-ucrt-r3
export const TOOLCHAIN = Object.freeze({
    release: '14.2.0posix-12.0.0-ucrt-r3',
    gcc: '14.2.0',
    llvm: '19.1.7',
    mingw: '12.0.0',
    gdb: '16.2',
    url: 'https://github.com/brechtsanders/winlibs_mingw/releases/download/14.2.0posix-12.0.0-ucrt-r3/winlibs-x86_64-posix-seh-gcc-14.2.0-llvm-19.1.7-mingw-w64ucrt-12.0.0-r3.7z',
    sha256: '75bc86c76d085dbd193fe6ab7facb09bbfaf31cb02384c3aeda7050495d7c7d9',
    bytes: 168271478,
    // Bump when changing the pruning policy so an existing installation is refreshed.
    layout: 1
})

const root = fileURLToPath(new URL('../', import.meta.url))
const cache = path.join(root, '.cache/toolchain')
const archive = path.join(cache, path.basename(TOOLCHAIN.url))
const target = path.join(root, 'resources/toolchain')
const required = ['g++.exe', 'gdb.exe', 'clangd.exe', 'clang-format.exe']
const exists = (file) =>
    access(file).then(
        () => true,
        () => false
    )
const mib = (bytes) => (bytes / 1024 ** 2).toFixed(1)

export async function readToolchainMarker(file) {
    try {
        return JSON.parse(await readFile(file, 'utf8'))
    } catch {
        return null
    }
}

export async function writeToolchainMarker(file, marker) {
    const text = `${JSON.stringify(marker, null, 2)}\n`
    if ((await readFile(file, 'utf8').catch(() => null)) === text) return false
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
        await writeFile(temporary, text, { flag: 'wx' })
        await rename(temporary, file)
    } finally {
        await rm(temporary, { force: true })
    }
    return true
}

async function verify(file) {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    const actual = hash.digest('hex')
    if (actual !== TOOLCHAIN.sha256) {
        throw new Error(`SHA-256 mismatch: expected ${TOOLCHAIN.sha256}, got ${actual}. Delete ${file} and retry.`)
    }
    console.log(`SHA-256 verified: ${actual}`)
}

async function download() {
    if (await exists(archive)) return
    const partial = `${archive}.part`
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const offset = await stat(partial).then(
                (s) => s.size,
                () => 0
            )
            if (offset === TOOLCHAIN.bytes) {
                await verify(partial)
                await rename(partial, archive)
                return
            }
            const response = await fetch(TOOLCHAIN.url, {
                headers: offset ? { Range: `bytes=${offset}-` } : {},
                signal: AbortSignal.timeout(30 * 60 * 1000)
            })
            if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`)
            const append = response.status === 206
            if (append && !response.headers.get('content-range')?.startsWith(`bytes ${offset}-`)) {
                await response.body.cancel()
                throw new Error('Server returned an unexpected byte range')
            }
            let received = append ? offset : 0
            let lastLog = 0
            console.log(`${append ? 'Resuming' : 'Downloading'} ${TOOLCHAIN.url}`)
            const progress = new Transform({
                transform(chunk, _encoding, callback) {
                    received += chunk.length
                    if (Date.now() - lastLog >= 2000) {
                        console.log(
                            `${((100 * received) / TOOLCHAIN.bytes).toFixed(1)}% (${mib(received)} / ${mib(TOOLCHAIN.bytes)} MiB)`
                        )
                        lastLog = Date.now()
                    }
                    callback(null, chunk)
                }
            })
            await pipeline(
                Readable.fromWeb(response.body),
                progress,
                createWriteStream(partial, { flags: append ? 'a' : 'w' })
            )
            if (received !== TOOLCHAIN.bytes)
                throw new Error(`Incomplete archive: ${received} / ${TOOLCHAIN.bytes} bytes`)
            await rename(partial, archive)
            console.log(`Downloaded ${mib(received)} MiB`)
            return
        } catch (error) {
            console.error(`Download attempt ${attempt}/3: ${error.message}`)
            if (attempt === 3) throw error
        }
    }
}

async function run(executable, args) {
    await new Promise((resolve, reject) => {
        const child = spawn(executable, args, { stdio: 'inherit', windowsHide: true })
        child.on('error', reject)
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${executable} exited with ${code}`))))
    })
}

async function prepareGdb(directory) {
    const { applied, ...metadata } = await ensureGdbUtf8(directory)
    if (applied) console.log(`Bundled GDB UTF-8 manifest prepared: ${metadata.patchedSha256}`)
    return metadata
}

// Only remove known documentation trees. Keep licenses, share/gdb, share/gcc-*,
// Python, all DLLs, headers, libraries and compiler backends (including LTO).
async function prune(directory) {
    for (const name of ['doc', 'docs', 'man', 'info', 'share/doc', 'share/info', 'share/man']) {
        await rm(path.join(directory, name), { recursive: true, force: true })
    }
    const gcc = path.join(directory, 'libexec/gcc')
    async function removeUnusedFrontends(dir) {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name)
            if (entry.isDirectory()) await removeUnusedFrontends(file)
            else if (/^(f951|gnat1|cc1obj|cc1objplus)\.exe$/i.test(entry.name)) await rm(file)
        }
    }
    if (await exists(gcc)) await removeUnusedFrontends(gcc)
    for (const entry of await readdir(path.join(directory, 'bin'))) {
        if (/^(?:x86_64-w64-mingw32-)?(?:gfortran|g77|g95|gnat[^.]*)(?:-\d+(?:\.\d+)*)?\.exe$/i.test(entry)) {
            await rm(path.join(directory, 'bin', entry))
        }
    }
}

async function main() {
    await mkdir(cache, { recursive: true })
    await download()
    await verify(archive)
    const markerFile = path.join(target, 'iter-toolchain.json')
    const marker = await readToolchainMarker(markerFile)
    if (
        marker?.sha256 === TOOLCHAIN.sha256 &&
        marker?.layout === TOOLCHAIN.layout &&
        (await Promise.all(required.map((name) => exists(path.join(target, 'bin', name))))).every(Boolean)
    ) {
        const gdbCompatibility = await prepareGdb(target)
        await writeToolchainMarker(markerFile, { ...marker, gdbCompatibility })
        console.log(`Toolchain already ready: ${target}`)
        return
    }
    // Extract to a staging directory; do not replace a usable toolchain on failure.
    const staging = path.join(cache, 'extract')
    const previous = path.join(cache, 'previous')
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    await run(sevenZip.path7za, ['x', archive, `-o${staging}`, '-y', '-bsp0'])
    const extracted = path.join(staging, 'mingw64')
    for (const name of required) {
        if (!(await exists(path.join(extracted, 'bin', name)))) throw new Error(`Archive missing bin/${name}`)
    }
    await prune(extracted)
    const gdbCompatibility = await prepareGdb(extracted)
    await writeToolchainMarker(path.join(extracted, 'iter-toolchain.json'), { ...TOOLCHAIN, gdbCompatibility })
    await mkdir(path.dirname(target), { recursive: true })
    await rm(previous, { recursive: true, force: true })
    const hadPrevious = await exists(target)
    if (hadPrevious) await rename(target, previous)
    try {
        await rename(extracted, target)
    } catch (error) {
        if (hadPrevious) await rename(previous, target)
        throw error
    }
    await rm(previous, { recursive: true, force: true })
    await rm(staging, { recursive: true, force: true })
    console.log(`Toolchain ready: ${target}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error.message)
        process.exitCode = 1
    })
}
