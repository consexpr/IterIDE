import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))

const rootFiles = new Set([
    '.clang-format',
    '.editorconfig',
    '.gitattributes',
    '.gitignore',
    '.prettierignore',
    '.prettierrc.json',
    'README.md',
    'LICENSE',
    'CONTRIBUTING.md',
    'THIRD_PARTY_NOTICES.md',
    'app/.gitignore',
    'app/package.json',
    'app/package-lock.json',
    'app/tsconfig.json',
    'app/electron.vite.config.ts',
    'app/electron-builder.yml',
    'app/vitest.config.mts',
    'docs/THEMES.md'
])

const modelFiles = new Set([
    'manifest.json',
    'ranker.onnx',
    'tokenizer.cpp',
    'runtime/ort.wasm.min.js',
    'runtime/ort-wasm-simd-threaded.wasm',
    'runtime/ort-wasm-simd-threaded.mjs',
    'runtime/LICENSE.txt',
    'runtime/ThirdPartyNotices.txt'
])

const directories = [
    '.github',
    'app/src',
    'app/scripts',
    'app/docs',
    'app/plugins',
    'app/resources/model',
    'app/resources/runner',
    'app/resources/sdk',
    'app/resources/testlib',
    'docs/theme-examples'
]

const localDirectory =
    /(^|\/)(node_modules|out|dist|\.cache|\.git|\.backups|\.idea|\.vscode|__pycache__|coverage|test-results)(\/|$)/
const credential = /(^|\/)(\.env(?:\..*)?|id_rsa|id_ed25519|sync-token\.json)$|\.(pem|pfx|p12|key)$/i
const historical = /^app\/docs\/(maintenance-[^/]+\.md|model-v2-design\.md|model-v2(?:\/|$))/

export function isPublicFile(file) {
    if (file.includes('\\') || file.split('/').some((part) => !part || part === '.' || part === '..')) return false
    if (rootFiles.has(file)) return true
    if (localDirectory.test(file) || credential.test(file) || historical.test(file)) return false
    if (file.startsWith('app/resources/model/')) return modelFiles.has(file.slice('app/resources/model/'.length))
    if (file.startsWith('app/resources/testlib/')) return /\/(testlib\.h|LICENSE)$/.test(file)
    if (file.startsWith('app/resources/runner/')) return /\/(runner\.cpp|README\.md)$/.test(file)
    if (file.startsWith('.github/')) return /^\.github\/workflows\/[\w-]+\.ya?ml$/.test(file)
    if (!directories.some((directory) => file.startsWith(`${directory}/`))) return false
    return /\.(?:ts|tsx|js|mjs|cjs|json|css|html|md|ps1|cpp|h|in|ans|out|svg|png|webp|mp4|woff2?)$/i.test(file)
}

/** Walk only source roots. Never descend into caches, profiles or downloaded toolchains. */
export async function publicFiles(root = repositoryRoot) {
    const files = []
    const checked = new Set()
    async function checkDirectory(directory) {
        if (checked.has(directory)) return
        if (directory) {
            const parent = path.posix.dirname(directory)
            await checkDirectory(parent === '.' ? '' : parent)
        }
        const stat = await lstat(path.join(root, directory))
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new Error(`Not a regular source directory: ${directory || root}`)
        }
        checked.add(directory)
    }
    async function collect(directory) {
        const entries = await (async () => {
            await checkDirectory(directory)
            return readdir(path.join(root, directory), { withFileTypes: true })
        })().catch((error) => {
            if (error.code === 'ENOENT' && ['.github', 'app/plugins'].includes(directory)) return []
            throw error
        })
        for (const entry of entries) {
            const file = `${directory}/${entry.name}`
            if (localDirectory.test(file) || historical.test(file)) continue
            if (entry.isSymbolicLink()) throw new Error(`Symlinks are not release inputs: ${file}`)
            if (entry.isDirectory()) await collect(file)
            else if (entry.isFile() && isPublicFile(file)) files.push(file)
        }
    }
    files.push(...rootFiles)
    for (const directory of directories) await collect(directory)
    return files.sort()
}
