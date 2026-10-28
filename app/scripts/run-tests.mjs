import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const appRoot = fileURLToPath(new URL('../', import.meta.url))

/** Every test command gets its own profile, store and temporary files, even without caller setup. */
export async function testEnvironment(parent, original = process.env) {
    await mkdir(parent, { recursive: true })
    const root = await mkdtemp(path.join(parent, 'run-'))
    const directories = {
        ITER_DATA_DIR: path.join(root, 'runtime'),
        ITER_STORE: path.join(root, 'store'),
        TEMP: path.join(root, 'tmp'),
        APPDATA: path.join(root, 'profile', 'Roaming'),
        LOCALAPPDATA: path.join(root, 'profile', 'Local'),
        USERPROFILE: path.join(root, 'profile')
    }
    await Promise.all(Object.values(directories).map((directory) => mkdir(directory, { recursive: true })))
    const env = {
        ...original,
        ...directories,
        ITER_TEST_ROOT: root,
        TMP: directories.TEMP,
        TMPDIR: directories.TEMP,
        HOME: directories.USERPROFILE
    }
    for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'ITER_CAPTURE', 'ITER_EVAL']) delete env[name]
    return { root, env }
}

async function main() {
    const args = process.argv.slice(2)
    const full = args.includes('--full')
    const { root, env } = await testEnvironment(path.join(appRoot, '.cache', 'test-runs'))
    if (full) {
        env.ITER_TEST_MODEL_INTEGRATION = '1'
        env.ITER_TEST_RENDERER_LAYOUT = '1'
    }
    console.log(`Isolated test data: ${root}`)
    const child = spawn(
        process.execPath,
        [path.join(appRoot, 'node_modules', 'vitest', 'vitest.mjs'), 'run', ...args.filter((arg) => arg !== '--full')],
        { cwd: appRoot, env, windowsHide: true, stdio: 'inherit' }
    )
    const code = await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (status, signal) => resolve(status ?? (signal ? 1 : 0)))
    })
    // Preserve failed runs for diagnosis. Successful temporary user data has no lasting value.
    if (code === 0) await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
    process.exitCode = code
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main()
}
