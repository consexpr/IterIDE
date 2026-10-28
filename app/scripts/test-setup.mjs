import { mkdirSync, mkdtempSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Runs before each test file, including direct `vitest` invocations. Separate workers
// must never compete over the application's global problem index or user profile.
const appRoot = fileURLToPath(new URL('../', import.meta.url))
const parent = process.env.ITER_TEST_ROOT || path.join(appRoot, '.cache', 'test-runs')
mkdirSync(parent, { recursive: true })
const root = mkdtempSync(path.join(parent, 'file-'))
const directories = {
    ITER_STORE: path.join(root, 'store'),
    ITER_DATA_DIR: path.join(root, 'runtime'),
    TEMP: path.join(root, 'tmp'),
    APPDATA: path.join(root, 'profile', 'Roaming'),
    LOCALAPPDATA: path.join(root, 'profile', 'Local'),
    USERPROFILE: path.join(root, 'profile')
}
for (const [name, directory] of Object.entries(directories)) {
    mkdirSync(directory, { recursive: true })
    process.env[name] = directory
}
process.env.TMP = directories.TEMP
process.env.TMPDIR = directories.TEMP
process.env.HOME = directories.USERPROFILE
