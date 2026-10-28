import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ToolchainSettings } from '../../shared/judge'
import { compileSource } from '../judge/compile'
import { holdCachePath } from '../judge/cache-lru'
import { killTree } from '../judge/process'
import { toolchainEnv } from '../toolchain'
import { terminalHostSource } from './native'
import { pumpTerminalOutput } from './output'

export interface TerminalHost {
    closed: Promise<void>
    stop(): void
}

/** The terminal window as seen by the helper bridge; the Electron window implements it. */
export interface TerminalView {
    readonly cols: number
    readonly rows: number
    /** Resolves once the window is gone. */
    readonly closed: Promise<void>
    /** Resolves after the terminal has parsed this chunk or the window closes. */
    write(data: Uint8Array): Promise<void>
    exited(code: number): void
    onInput(listener: (data: string) => void): void
    onResize(listener: (cols: number, rows: number) => void): void
    close(): void
}

const frame = (type: string, payload: Uint8Array = new Uint8Array()): Buffer => {
    const out = Buffer.alloc(5 + payload.length)
    out.write(type, 0, 'latin1')
    out.writeUInt32LE(payload.length, 1)
    out.set(payload, 5)
    return out
}

export async function buildTerminalHost(
    root: string,
    settings: ToolchainSettings,
    signal: AbortSignal
): Promise<{ exe: string; release(): void }> {
    const sourcePath = path.join(root, 'console-host.cpp')
    await fs.mkdir(root, { recursive: true })
    // Use the same resolver/cache as the solution, with fixed flags for this
    // application-owned helper instead of arbitrary problem/grader flags.
    await fs.writeFile(sourcePath, terminalHostSource)
    const result = await compileSource(
        sourcePath,
        terminalHostSource,
        { ...settings, flags: '-std=c++17 -O2 -municode' },
        false,
        '',
        signal
    )
    if (!result.ok || !result.exe) throw new Error(`无法构建终端窗口：${result.output || '编译器没有生成可执行文件'}`)
    return { exe: result.exe, release: holdCachePath(result.exe) }
}

export async function launchTerminalHost(
    host: string,
    executable: string,
    cwd: string,
    statusFile: string,
    signal: AbortSignal,
    view: TerminalView
): Promise<TerminalHost> {
    signal.throwIfAborted()
    const child: ChildProcess = spawn(host, [executable, cwd, statusFile, String(view.cols), String(view.rows)], {
        cwd,
        env: toolchainEnv(),
        detached: true,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
        shell: false
    })
    let exited = false,
        spawnError: Error | undefined,
        stopping = false,
        killTimer: ReturnType<typeof setTimeout> | undefined
    const abort = (): void => {
        if (!stopping && !exited) {
            stopping = true
            // EOF lets the helper's waiter close ConPTY after killing its job. A
            // forced exit remains bounded if native cleanup itself stops responding.
            child.stdin?.end()
            killTimer = setTimeout(() => killTree(child, true), 1500)
            killTimer.unref()
        }
        view.close()
    }
    const childClosed = new Promise<void>((resolve) => {
        child.once('error', (error) => {
            spawnError = error
        })
        child.once('close', () => {
            exited = true
            clearTimeout(killTimer)
            signal.removeEventListener('abort', abort)
            resolve()
        })
    })
    const outputTask = pumpTerminalOutput(child.stdout!, view).catch((error) => {
        spawnError = error instanceof Error ? error : new Error(String(error))
        abort()
    })
    const closed = Promise.all([childClosed, view.closed, outputTask]).then(() => undefined)
    const post = (data: Buffer): void => {
        if (!stopping && child.stdin?.writable) child.stdin.write(data, () => {})
    }
    child.stdin?.on('error', () => {})
    view.onInput((data) => post(frame('i', Buffer.from(data, 'utf8'))))
    view.onResize((cols, rows) => {
        const size = Buffer.alloc(4)
        size.writeUInt16LE(cols, 0)
        size.writeUInt16LE(rows, 2)
        post(frame('r', size))
    })
    // Closing the window ends the helper's stdin, which makes it kill the program's job.
    void view.closed.then(abort)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    try {
        // The helper confirms that the program started before the UI reports an open
        // terminal. A missing pseudo console or runtime DLL becomes an actionable error.
        const deadline = Date.now() + 10_000
        while (!exited && Date.now() < deadline) {
            signal.throwIfAborted()
            const status = await fs.readFile(statusFile, 'utf8').catch((error: NodeJS.ErrnoException) => {
                if (error.code === 'ENOENT') return ''
                throw error
            })
            if (status === 'ready') {
                signal.throwIfAborted()
                return { closed, stop: abort }
            }
            if (status.startsWith('error:')) throw new Error(`终端启动失败：${status.slice(6)}`)
            await new Promise<void>((resolve) => setTimeout(resolve, 20))
        }
        signal.throwIfAborted()
        throw new Error(
            spawnError
                ? `无法打开终端：${spawnError.message}`
                : exited
                  ? '终端程序在启动完成前退出，请检查工具链运行库'
                  : '终端窗口启动超时'
        )
    } catch (error) {
        abort()
        await closed
        throw error
    }
}
