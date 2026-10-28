import { execFileSync } from 'node:child_process'
import { copyFile, lstat, mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { publicFiles, repositoryRoot } from './repository-files.mjs'

const requested = path.resolve(process.argv[2] || path.join(repositoryRoot, '..', 'ITER-GitHub'))
// Resolve the existing parent so junctions cannot redirect an export into the working copy.
const destination = path.join(await realpath(path.dirname(requested)), path.basename(requested))
const relative = path.relative(await realpath(repositoryRoot), destination)
if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Choose a new directory outside this working copy.')
}
if (
    await lstat(destination).catch((error) => {
        if (error.code !== 'ENOENT') throw error
    })
) {
    throw new Error(`Destination already exists; choose a new directory: ${destination}`)
}

execFileSync(process.execPath, [path.join(repositoryRoot, 'app/scripts/check-repo.mjs')], { stdio: 'inherit' })
const files = await publicFiles()
// Validate the entire list before creating the destination. Do not follow source symlinks.
let bytes = 0
for (const file of files) {
    const stat = await lstat(path.join(repositoryRoot, file))
    if (!stat.isFile()) throw new Error(`Not a regular release file: ${file}`)
    bytes += stat.size
}
await mkdir(destination, { recursive: true })
for (const file of files) {
    const output = path.join(destination, file)
    await mkdir(path.dirname(output), { recursive: true })
    await copyFile(path.join(repositoryRoot, file), output)
}
execFileSync(process.execPath, [path.join(destination, 'app/scripts/check-repo.mjs'), '--strict'], {
    cwd: destination,
    stdio: 'inherit'
})
console.log(`GitHub source: ${destination}\n${files.length} files, ${(bytes / 1024 / 1024).toFixed(2)} MiB`)
