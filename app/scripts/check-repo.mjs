import { execFileSync } from 'node:child_process'
import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { isPublicFile, publicFiles, repositoryRoot as root } from './repository-files.mjs'

const hasGit = Boolean(
    await lstat(path.join(root, '.git')).catch((error) => {
        if (error.code !== 'ENOENT') throw error
    })
)
const strict = process.argv.includes('--strict')
async function allFiles(directory = '') {
    const files = []
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
        if (!directory && entry.name === '.git') continue
        const file = directory ? `${directory}/${entry.name}` : entry.name
        if (entry.isDirectory()) files.push(...(await allFiles(file)))
        else files.push(file)
    }
    return files
}

const published = await publicFiles()
const candidates = strict
    ? await allFiles()
    : hasGit
      ? execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
            cwd: root,
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024
        })
            .split('\0')
            .filter(Boolean)
      : published
const files = [...new Set([...published, ...candidates])]
const errors = []
const metadata = JSON.parse(await readFile(path.join(root, 'app/package.json'), 'utf8'))
const lock = JSON.parse(await readFile(path.join(root, 'app/package-lock.json'), 'utf8'))
if (metadata.name !== 'iter' || lock.name !== 'iter' || lock.packages?.['']?.name !== 'iter') {
    errors.push('Release package names must all be iter.')
}
const installerConfig = await readFile(path.join(root, 'app/electron-builder.yml'), 'utf8')
for (const [key, expected] of [
    ['appId', 'dev.iter.editor'],
    ['productName', 'ITER'],
    ['executableName', 'ITER'],
    ['shortcutName', 'ITER']
]) {
    const value = installerConfig
        .match(new RegExp(`^\\s*${key}:\\s*([^\\r\\n#]+)`, 'm'))?.[1]
        .trim()
        .replace(/^(['"])(.*)\1$/, '$2')
    if (value !== expected) errors.push(`Installer ${key} must be ${expected}.`)
}
// Let electron-builder derive the installation registry key from ITER's appId.
if (/^\s+guid\s*:/m.test(installerConfig)) errors.push('Do not override the installer GUID derived from appId.')
let bytes = 0
for (const file of files) {
    if (!isPublicFile(file)) {
        errors.push(`Non-public file in release/commit candidates: ${file}`)
        continue
    }
    const stat = await lstat(path.join(root, file)).catch((error) => {
        if (error.code !== 'ENOENT') throw error
    })
    if (!stat?.isFile()) {
        errors.push(`Missing or non-regular release input: ${file}`)
        continue
    }
    bytes += stat.size
    if (stat.size > 50 * 1024 * 1024) errors.push(`File exceeds 50 MiB: ${file}`)
    if (/\.(?:ts|tsx|js|mjs|cjs|json|md|ps1|ya?ml)$/.test(file)) {
        const text = await readFile(path.join(root, file), 'utf8')
        // Report the filename only, never a matched secret.
        if (
            /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{70,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(
                text
            )
        ) {
            errors.push(`Possible credential in public file: ${file}`)
        }
        if (file.endsWith('.md') && /\]\((?:[A-Za-z]:[/\\]|file:\/\/)/.test(text)) {
            errors.push(`Machine-local Markdown link: ${file}`)
        }
        if (file.endsWith('.md') && text.includes('\uFFFD')) errors.push(`Damaged text encoding: ${file}`)
    }
}

const modelRoot = path.join(root, 'app/resources/model')
const manifest = JSON.parse(await readFile(path.join(modelRoot, 'manifest.json'), 'utf8'))
for (const file of [
    'ranker.onnx',
    'runtime/ort.wasm.min.js',
    'runtime/ort-wasm-simd-threaded.wasm',
    'runtime/ort-wasm-simd-threaded.mjs',
    'runtime/LICENSE.txt',
    'runtime/ThirdPartyNotices.txt'
]) {
    if (!/^[a-f0-9]{64}$/.test(manifest.assets?.[file] || '')) errors.push(`Missing model asset digest: ${file}`)
    if (!files.includes(`app/resources/model/${file}`)) errors.push(`Missing model asset: ${file}`)
}
if (hasGit) {
    execFileSync('git', ['diff', '--check'], { cwd: root, stdio: 'inherit' })
    execFileSync('git', ['diff', '--cached', '--check'], { cwd: root, stdio: 'inherit' })
}
if (errors.length) {
    console.error([...new Set(errors)].join('\n'))
    process.exitCode = 1
} else {
    console.log(`Repository checks passed (${files.length} public files, ${(bytes / 1024 / 1024).toFixed(2)} MiB).`)
}
