import { access, rename, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = path.join(root, 'resources', 'runner')
const output = path.join(directory, 'runner.exe')
const temporary = path.join(directory, `runner-build-${process.pid}.exe`)

try {
    if (process.platform !== 'win32') throw new Error('build-runner must run on Windows with a MinGW g++ toolchain')
    const bundled = path.join(root, 'resources', 'toolchain', 'bin', 'g++.exe')
    const hasBundled = await access(bundled, constants.F_OK).then(
        () => true,
        () => false
    )
    const compiler = hasBundled ? bundled : 'g++'
    const env = { ...process.env }
    if (hasBundled) {
        const keys = Object.keys(env).filter((key) => key.toLowerCase() === 'path')
        const key = keys[0] ?? 'PATH'
        env[key] = [path.dirname(bundled), env[key]].filter(Boolean).join(path.delimiter)
        for (const duplicate of keys.slice(1)) delete env[duplicate]
    }
    await new Promise((resolve, reject) => {
        const child = spawn(
            compiler,
            [
                '-std=c++17',
                '-O2',
                '-static',
                path.join(directory, 'runner.cpp'),
                '-o',
                temporary,
                '-lpsapi',
                '-lshell32'
            ],
            {
                cwd: root,
                env,
                windowsHide: true,
                stdio: 'inherit'
            }
        )
        child.once('error', reject)
        child.once('close', (code) =>
            code === 0 ? resolve() : reject(new Error(`Runner compilation failed (${code})`))
        )
    })
    await rename(temporary, output)
    console.log(`Built ${output}`)
} catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
} finally {
    await rm(temporary, { force: true })
}
