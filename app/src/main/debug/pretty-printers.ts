import { promises as fs } from 'node:fs'
import path from 'node:path'
import { MIClient } from './mi-client'
import { miQuote } from './mi'
import { runProcess } from './process'

interface PrinterSupport {
    python: boolean
    directory?: string
}
const cache = new Map<string, Promise<PrinterSupport>>()

async function discover(compiler: string, gdb: string): Promise<PrinterSupport> {
    const configuration = await runProcess(gdb, ['--configuration'], { timeout: 8_000 })
    if (!/--with-python(?:=|\s)/.test(configuration.output)) return { python: false }
    const roots = new Set<string>()
    const addAncestors = (file: string): void => {
        let dir = path.dirname(file)
        for (let i = 0; i < 7; i++) {
            roots.add(dir)
            const parent = path.dirname(dir)
            if (parent === dir) break
            dir = parent
        }
    }
    addAncestors(compiler)
    for (const library of ['libstdc++.so', 'libstdc++.a', 'python']) {
        try {
            const found = (
                await runProcess(compiler, [`-print-file-name=${library}`], { timeout: 8_000 })
            ).output.trim()
            if (path.isAbsolute(found)) {
                addAncestors(found)
                if (library === 'python') roots.add(found)
            }
        } catch {
            /* GCC-compatible discovery is optional */
        }
    }
    for (const root of roots) {
        const candidates = [root, path.join(root, 'python')]
        try {
            const share = path.join(root, 'share')
            for (const entry of await fs.readdir(share)) {
                if (/^gcc(?:-|$)/.test(entry)) candidates.push(path.join(share, entry, 'python'))
            }
        } catch {
            /* no share directory */
        }
        for (const directory of candidates) {
            try {
                await fs.access(path.join(directory, 'libstdcxx', 'v6', 'printers.py'))
                return { python: true, directory }
            } catch {
                /* next installation layout */
            }
        }
    }
    return { python: true }
}

export async function enablePrettyPrinters(client: MIClient, compiler: string, gdb: string): Promise<string> {
    const key = `${compiler}\0${gdb}`
    let support = cache.get(key)
    if (!support) {
        support = discover(compiler, gdb).catch(() => ({ python: false }))
        cache.set(key, support)
    }
    const { python, directory } = await support
    if (!python) return 'GDB Python unavailable; using raw C++ values.\n'
    if (!directory) return 'GDB has Python; libstdc++ printers were not found. Using raw C++ values.\n'
    try {
        const script = `python import sys; sys.path.insert(0, ${JSON.stringify(directory.replace(/\\/g, '/'))}); from libstdcxx.v6.printers import register_libstdcxx_printers; register_libstdcxx_printers(None)`
        await client.command(`-interpreter-exec console ${miQuote(script)}`)
        await client.command('-enable-pretty-printing')
        // Xmethods let GDB read e.g. vector[i] even when the program never emitted
        // an out-of-line operator[] symbol. Failure leaves the printers usable.
        await client
            .command(
                `-interpreter-exec console ${miQuote('python from libstdcxx.v6.xmethods import register_libstdcxx_xmethods; register_libstdcxx_xmethods(None)')}`
            )
            .catch(() => {})
        return `GDB Python/libstdc++ pretty printers enabled: ${directory}\n`
    } catch {
        return 'GDB Python/printer initialization failed; using raw C++ values.\n'
    }
}
