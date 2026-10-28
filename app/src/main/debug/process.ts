import { spawn, type ChildProcess } from 'node:child_process'
import { toolchainEnv } from '../toolchain'

/** Kill both a launcher (some MinGW gdb.exe files wrap gdborig.exe) and its children. */
export async function killTree(child: ChildProcess, inferiors: Iterable<number> = []): Promise<void> {
    const pids = [...inferiors, child.pid].filter((pid): pid is number => !!pid)
    if (process.platform === 'win32') {
        await Promise.all(
            pids.map(
                (pid) =>
                    new Promise<void>((resolve) => {
                        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
                            windowsHide: true,
                            stdio: 'ignore'
                        })
                        killer.once('error', () => {
                            try {
                                process.kill(pid)
                            } catch {
                                /* already gone */
                            }
                            resolve()
                        })
                        killer.once('close', (code) => {
                            // Restricted Windows sessions may deny taskkill even for our own children.
                            if (code !== 0) {
                                try {
                                    process.kill(pid)
                                } catch {
                                    /* already gone */
                                }
                            }
                            resolve()
                        })
                    })
            )
        )
    } else {
        for (const pid of pids) {
            try {
                process.kill(-pid, 'SIGKILL')
            } catch {
                /* not a process group leader */
            }
            try {
                process.kill(pid, 'SIGKILL')
            } catch {
                /* already gone */
            }
        }
    }
    if (child.pid && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
            const finish = (): void => {
                clearTimeout(timer)
                child.removeListener('close', finish)
                resolve()
            }
            const timer = setTimeout(finish, 1_000)
            child.once('close', finish)
        })
    }
}

export async function runProcess(
    exe: string,
    args: string[],
    options: {
        cwd?: string
        signal?: AbortSignal
        timeout?: number
    } = {}
): Promise<{ code: number | null; output: string }> {
    options.signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
        const child = spawn(exe, args, {
            cwd: options.cwd,
            env: toolchainEnv(),
            windowsHide: true,
            detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe']
        })
        let output = ''
        let timedOut = false
        const collect = (data: string): void => {
            if (output.length < 2_000_000) output += data
        }
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', collect)
        child.stderr.on('data', collect)
        const abort = (): void => {
            void killTree(child)
        }
        options.signal?.addEventListener('abort', abort, { once: true })
        const timer = setTimeout(() => {
            timedOut = true
            abort()
        }, options.timeout ?? 60_000)
        const clean = (): void => {
            clearTimeout(timer)
            options.signal?.removeEventListener('abort', abort)
        }
        child.once('error', (error) => {
            clean()
            reject(error)
        })
        child.once('close', (code) => {
            clean()
            if (options.signal?.aborted) reject(new Error('Debug session cancelled'))
            else if (timedOut) reject(new Error(`${exe} timed out\n${output}`))
            else resolve({ code, output })
        })
    })
}
