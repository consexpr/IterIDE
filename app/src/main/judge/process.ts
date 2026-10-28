import {
    spawn,
    type ChildProcess,
    type ChildProcessByStdio,
    type ChildProcessWithoutNullStreams
} from 'node:child_process'
import { closeSync, createWriteStream, openSync } from 'node:fs'
import type { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { StringDecoder } from 'node:string_decoder'
import { toolchainEnv } from '../toolchain'
import { holdCachePath } from './cache-lru'

export function killTree(child: ChildProcess, ownsJob = false): void {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
    if (process.platform === 'win32') {
        // A native runner owns a kill-on-close job. Terminate it directly instead of
        // racing an asynchronous taskkill process against the pipe teardown.
        if (ownsJob) {
            child.kill('SIGKILL')
            return
        }
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore'
        })
        // Restricted Windows environments can refuse taskkill even for our children.
        // The ChildProcess handle still permits terminating the direct child.
        const fallback = setTimeout(() => child.kill('SIGKILL'), 150)
        fallback.unref()
        killer.on('error', () => child.kill('SIGKILL'))
        killer.on('close', () => {
            clearTimeout(fallback)
            child.kill('SIGKILL')
        })
    } else {
        try {
            process.kill(-child.pid, 'SIGTERM')
        } catch {
            child.kill('SIGTERM')
        }
        const timer = setTimeout(() => {
            try {
                process.kill(-child.pid!, 'SIGKILL')
            } catch {
                /* exited */
            }
        }, 150)
        timer.unref()
    }
}

export function launch(
    command: string,
    args: string[],
    cwd?: string,
    input?: undefined,
    runner?: string
): ChildProcessWithoutNullStreams
export function launch(
    command: string,
    args: string[],
    cwd: string | undefined,
    input: string,
    runner?: string
): ChildProcessByStdio<null, Readable, Readable>
export function launch(command: string, args: string[], cwd?: string, input?: string, runner?: string): ChildProcess {
    // Batch input is a finite file, including through the native helper. In particular,
    // Windows readers must not depend on a parent pipe being closed to observe EOF.
    const fd = input === undefined ? undefined : openSync(input, 'r')
    let child: ChildProcess
    try {
        child = spawn(runner ?? command, runner ? ['--exec', '--', command, ...args] : args, {
            cwd,
            env: toolchainEnv(),
            windowsHide: true,
            detached: process.platform !== 'win32',
            stdio: [fd ?? 'pipe', 'pipe', 'pipe']
        })
    } finally {
        // spawn has duplicated/inherited the descriptor; retain no parent copy.
        if (fd !== undefined) closeSync(fd)
    }
    // Programs often close stdin without consuming all input (including checker failures).
    child.stdin?.on('error', () => {})
    // end() can leave a Windows pipe's handle open. Close it after queued writes
    // finish so a native grandchild also observes EOF through the passthrough.
    child.stdin?.once('finish', () => child.stdin?.destroy())
    return child
}

export class Capture {
    private readonly decoder = new StringDecoder('utf8')
    text = ''
    bytes = 0
    truncated = false
    constructor(private readonly limit: number) {}
    push(data: Buffer): void {
        this.bytes += data.length
        if (this.truncated) return
        const text = this.decoder.write(data)
        const left = Math.max(0, this.limit - this.text.length)
        this.text += text.slice(0, left)
        this.truncated = text.length > left
    }
    end(): void {
        const tail = this.decoder.end()
        const left = Math.max(0, this.limit - this.text.length)
        this.text += tail.slice(0, left)
        this.truncated ||= tail.length > left
    }
}

/** Stop waiting for shared cache work without cancelling another run's build. */
export async function cancellable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
    if (!signal) return promise
    if (signal.aborted) return undefined
    let abort: () => void = () => {}
    const stopped = new Promise<undefined>((resolve) => {
        abort = () => resolve(undefined)
        signal.addEventListener('abort', abort, { once: true })
    })
    try {
        return await Promise.race([promise, stopped])
    } finally {
        signal.removeEventListener('abort', abort)
    }
}

export interface ProcessResult {
    code: number | null
    signal: NodeJS.Signals | null
    stdout: string
    stderr: string
    truncated: boolean
    timeMs: number
    timedOut: boolean
    outputExceeded: boolean
    error?: string
}

export async function execute(
    command: string,
    args: string[],
    options: {
        cwd?: string
        timeout: number
        signal?: AbortSignal
        input?: string
        output?: string
        runner?: string
        nativeJob?: boolean
        outputLimit?: number
        displayLimit?: number
        poll?: () => Promise<boolean>
    }
): Promise<ProcessResult> {
    const start = performance.now()
    const releaseCommand = holdCachePath(command),
        releaseRunner = options.runner ? holdCachePath(options.runner) : () => {}
    const out = new Capture(options.displayLimit ?? 2_000_000)
    const err = new Capture(options.displayLimit ?? 2_000_000)
    if (options.signal?.aborted) {
        releaseCommand()
        releaseRunner()
        return {
            code: null,
            signal: null,
            stdout: '',
            stderr: '',
            truncated: false,
            timeMs: 0,
            timedOut: false,
            outputExceeded: false,
            error: 'Stopped'
        }
    }
    let child: ChildProcessByStdio<Writable | null, Readable, Readable>
    try {
        child =
            options.input === undefined
                ? launch(command, args, options.cwd, undefined, options.runner)
                : launch(command, args, options.cwd, options.input, options.runner)
    } catch (error) {
        releaseCommand()
        releaseRunner()
        return {
            code: null,
            signal: null,
            stdout: '',
            stderr: '',
            truncated: false,
            timeMs: 0,
            timedOut: false,
            outputExceeded: false,
            error: `Cannot run ${command}: ${(error as Error).message}`
        }
    }
    let timedOut = false,
        outputExceeded = false,
        error: string | undefined
    const abort = (): void => killTree(child, !!(options.runner || options.nativeJob))
    options.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => {
        timedOut = true
        abort()
    }, options.timeout)
    let polling = false
    const poller = options.poll
        ? setInterval(() => {
              if (polling) return
              polling = true
              void options.poll!()
                  .then((over) => {
                      if (over) {
                          outputExceeded = true
                          abort()
                      }
                  })
                  .catch(() => {})
                  .finally(() => {
                      polling = false
                  })
          }, 15)
        : undefined
    const limit = options.outputLimit ?? 4_000_000
    const count = (): void => {
        if (out.bytes + err.bytes > limit && !outputExceeded) {
            outputExceeded = true
            abort()
        }
    }
    // pipeline applies backpressure to output; stdin already references the input file.
    const writing = options.output
        ? pipeline(child.stdout, createWriteStream(options.output)).catch((e) => {
              if (!outputExceeded && !options.signal?.aborted) error = `Output: ${e.message}`
              abort()
          })
        : Promise.resolve()
    child.stdout.on('data', (chunk: Buffer) => {
        out.push(chunk)
        count()
    })
    child.stderr.on('data', (chunk: Buffer) => {
        err.push(chunk)
        count()
    })
    child.stdin?.end()
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on('error', (e) => {
            error = `Cannot run ${command}: ${e.message}`
        })
        child.on('close', (code, signal) => resolve({ code, signal }))
    })
    clearTimeout(timer)
    if (poller) clearInterval(poller)
    options.signal?.removeEventListener('abort', abort)
    child.stdin?.destroy()
    await writing
    out.end()
    err.end()
    releaseCommand()
    releaseRunner()
    return {
        ...result,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
        timeMs: performance.now() - start,
        timedOut,
        outputExceeded,
        error
    }
}
