import { spawn } from 'node:child_process'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as prettier from 'prettier'

const appRoot = fileURLToPath(new URL('../', import.meta.url))
const root = path.resolve(appRoot, '..')
const write = process.argv.includes('--write')
const files = []
async function collect(directory, optional = false) {
    let entries
    try {
        entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
        if (optional && error.code === 'ENOENT') return
        throw error
    }
    for (const entry of entries) {
        const file = path.join(directory, entry.name)
        if (entry.isDirectory()) await collect(file)
        else if (entry.isFile()) files.push(file)
    }
}
for (const directory of ['src', 'scripts', 'docs', 'resources/sdk']) await collect(path.join(appRoot, directory))
// Git does not preserve empty plugin directories in a fresh checkout.
await collect(path.join(appRoot, 'plugins'), true)
await collect(path.join(root, 'docs'))
await collect(path.join(root, '.github'), true)
files.push(
    ...[
        'package.json',
        'tsconfig.json',
        'electron.vite.config.ts',
        'vitest.config.mts',
        'electron-builder.yml',
        'resources/model/manifest.json',
        'resources/runner/README.md'
    ].map((file) => path.join(appRoot, file))
)
files.push(
    ...['.prettierrc.json', 'README.md', 'CONTRIBUTING.md', 'THIRD_PARTY_NOTICES.md'].map((file) =>
        path.join(root, file)
    )
)
const options = await prettier.resolveConfig(path.join(appRoot, 'package.json'))
const changed = []
let count = 0
for (const file of files.sort()) {
    const info = await prettier.getFileInfo(file, { ignorePath: path.join(root, '.prettierignore') })
    if (info.ignored || !info.inferredParser) continue
    const input = await readFile(file, 'utf8')
    const output = await prettier.format(input, { ...options, filepath: file })
    count++
    if (input === output) continue
    changed.push(path.relative(root, file))
    if (write) await writeFile(file, output)
}
if (changed.length) console.log(`${write ? 'Formatted' : 'Needs formatting'}: ${changed.length}/${count} files`)
else console.log(`Formatting passed (${count} authored source/config/documentation files).`)
if (!write && changed.length) {
    console.error(changed.join('\n'))
    process.exitCode = 1
}

const native = ['resources/model/tokenizer.cpp', 'resources/runner/runner.cpp'].map((file) => path.join(appRoot, file))
const formatter =
    process.env.ITER_CLANG_FORMAT ||
    path.join(appRoot, 'resources/toolchain/bin', process.platform === 'win32' ? 'clang-format.exe' : 'clang-format')
const child = spawn(
    formatter,
    [write ? '-i' : '--dry-run', ...(!write ? ['--Werror'] : []), '--style=file', ...native],
    { windowsHide: true, stdio: 'inherit' }
)
const code = await new Promise((resolve, reject) => {
    child.once('error', (error) =>
        reject(
            new Error('clang-format is unavailable; run npm run fetch-toolchain or set ITER_CLANG_FORMAT.', {
                cause: error
            })
        )
    )
    child.once('exit', (status) => resolve(status ?? 1))
})
if (code !== 0) process.exitCode = 1
