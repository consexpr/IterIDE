import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = path.join(root, 'resources/model')
const temporary = path.join(directory, `tokenizer-build-${process.pid}.exe`)
try {
    if (process.platform !== 'win32') throw Error('Model tokenizer requires the bundled Windows toolchain')
    const bin = path.join(root, 'resources/toolchain/bin')
    const env = { ...process.env }
    const keys = Object.keys(env).filter((key) => key.toLowerCase() === 'path')
    for (const key of keys) delete env[key]
    env.PATH = [bin, ...keys.map((key) => process.env[key])].filter(Boolean).join(path.delimiter)
    await new Promise((resolve, reject) => {
        const child = spawn(
            path.join(bin, 'g++.exe'),
            ['-std=c++17', '-O2', '-static', '-s', '-municode', path.join(directory, 'tokenizer.cpp'), '-o', temporary],
            { cwd: root, env, windowsHide: true, stdio: 'inherit' }
        )
        child.once('error', reject)
        child.once('close', (code) =>
            code === 0 ? resolve() : reject(Error(`Model tokenizer compilation failed (${code})`))
        )
    })
    await rename(temporary, path.join(directory, 'tokenizer.exe'))
    const manifestFile = path.join(directory, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
    manifest.assets['tokenizer.exe'] = createHash('sha256')
        .update(await readFile(path.join(directory, 'tokenizer.exe')))
        .digest('hex')
    await writeFile(manifestFile, JSON.stringify(manifest, null, 4) + '\n')
    console.log('Built Model tokenizer')
} catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
} finally {
    await rm(temporary, { force: true })
}
