import type { TestResult, ToolchainSettings, Verdict } from '../../shared/judge'
import { checkerArgs, checkerVerdict } from './checkers'
import { Capture, killTree, launch } from './process'
import { getPassthroughRunner } from './runner'
import { holdCachePath } from './cache-lru'

/** Interactive mode uses direct pipes; memory accounting is unavailable here. */
export async function runInteractive(options: {
    exe: string
    interactor: string
    args?: string
    scratch: string
    testId: string
    input: string
    output: string
    answer: string
    timeLimit: number
    tc: ToolchainSettings
    signal: AbortSignal
}): Promise<TestResult> {
    const { tc, signal, timeLimit } = options
    const runner = await getPassthroughRunner(tc, signal)
    const start = performance.now()
    const output = new Capture(tc.displayLimitChars),
        stderr = new Capture(tc.displayLimitChars),
        log = new Capture(tc.displayLimitChars)
    if (signal.aborted)
        return {
            testId: options.testId,
            verdict: 'SE',
            timeMs: 0,
            exitCode: null,
            output: '',
            stderr: '',
            checkerMessage: 'Stopped'
        }
    const user = launch(options.exe, [], options.scratch, undefined, runner)
    const interactor = launch(
        options.interactor,
        checkerArgs(options.args, { ...options, score: options.output + '.score' }),
        options.scratch,
        undefined,
        runner
    )
    const releases = [
        holdCachePath(options.exe),
        holdCachePath(options.interactor),
        ...(runner ? [holdCachePath(runner)] : [])
    ]
    let verdict: Verdict | undefined, message: string | undefined
    let interactorFinished = false,
        forced = false,
        userFinished = false
    let code: number | null = null,
        userSignal: NodeJS.Signals | null = null,
        userTime = 0
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined
    const kill = (): void => {
        user.stdin.destroy()
        interactor.stdin.destroy()
        killTree(user, !!runner)
        killTree(interactor, !!runner)
    }
    const fail = (v: Verdict, text: string): void => {
        if (!verdict) {
            verdict = v
            message = text
        }
        kill()
    }
    const abort = (): void => fail('SE', 'Stopped')
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(
        () => {
            if (!interactorFinished) fail('TLE', `Time limit exceeded (${timeLimit} ms)`)
        },
        timeLimit + Math.max(100, timeLimit * 0.15)
    )
    // The interactor participates in the whole conversation. Its finalization
    // budget starts only when the contestant exits, never before its time limit.
    let interactorTimer: ReturnType<typeof setTimeout> | undefined
    user.stdout.on('data', (chunk: Buffer) => {
        output.push(chunk)
        if (output.bytes + stderr.bytes > tc.outputLimitBytes) fail('OLE', 'Program output limit exceeded')
    })
    user.stderr.on('data', (chunk: Buffer) => {
        stderr.push(chunk)
        if (output.bytes + stderr.bytes > tc.outputLimitBytes) fail('OLE', 'Program output limit exceeded')
    })
    let interactorBytes = 0
    interactor.stdout.on('data', (chunk: Buffer) => {
        interactorBytes += chunk.length
        if (interactorBytes + log.bytes > tc.outputLimitBytes) fail('SE', 'Interactor output limit exceeded')
    })
    interactor.stderr.on('data', (chunk: Buffer) => {
        log.push(chunk)
        if (interactorBytes + log.bytes > tc.outputLimitBytes) fail('SE', 'Interactor output limit exceeded')
    })
    user.stdout.pipe(interactor.stdin)
    interactor.stdout.pipe(user.stdin)
    const userDone = new Promise<void>((resolve) => {
        user.on('error', (e) => fail('SE', `Cannot start program: ${e.message}`))
        user.on('close', (exit, sig) => {
            userFinished = true
            code = exit
            userSignal = sig
            userTime = performance.now() - start
            clearTimeout(timer)
            if (!interactorFinished && !forced && !verdict) {
                if (userTime > timeLimit) {
                    verdict = 'TLE'
                    message = `Time limit exceeded (${timeLimit} ms)`
                    kill()
                } else if (exit !== 0) {
                    verdict = 'RE'
                    message = `Program exited with ${sig ?? exit}`
                    kill()
                }
            }
            if (!interactorFinished && !verdict)
                interactorTimer = setTimeout(
                    () => fail('SE', 'Interactor did not finish within 1000 ms after program exit'),
                    1000
                )
            resolve()
        })
    })
    const interactorDone = new Promise<void>((resolve) => {
        interactor.on('error', (e) => fail('SE', `Cannot start interactor: ${e.message}`))
        interactor.on('close', (exit) => {
            interactorFinished = true
            clearTimeout(interactorTimer)
            clearTimeout(timer)
            if (!verdict) {
                const checked = checkerVerdict(exit, log.text)
                if (!userFinished && performance.now() - start > timeLimit) {
                    verdict = 'TLE'
                    message = `Time limit exceeded (${timeLimit} ms)`
                } else {
                    verdict = checked.verdict
                    message = checked.checkerMessage
                }
            }
            if (!userFinished)
                cleanupTimer = setTimeout(() => {
                    forced = true
                    user.stdin.destroy()
                    killTree(user, !!runner)
                }, 100)
            resolve()
        })
    })
    try {
        await Promise.all([userDone, interactorDone])
    } finally {
        clearTimeout(timer)
        clearTimeout(interactorTimer)
        clearTimeout(cleanupTimer)
        signal.removeEventListener('abort', abort)
        user.stdout.unpipe()
        interactor.stdout.unpipe()
        user.stdin.destroy()
        interactor.stdin.destroy()
        for (const release of releases) release()
    }
    // The interactor can observe EOF and report WA before the user's 'close' event
    // is delivered. Preserve a real crash even when those callbacks arrive in reverse
    // order, while keeping checker verdicts for programs we deliberately terminated.
    const crashed =
        process.platform === 'win32'
            ? code !== null && code >>> 0 >= 0x80000000
            : !!userSignal && ['SIGSEGV', 'SIGABRT', 'SIGBUS', 'SIGILL', 'SIGFPE'].includes(userSignal)
    if (crashed && !forced && (!verdict || verdict === 'AC' || verdict === 'WA' || verdict === 'PE')) {
        verdict = 'RE'
        message = `Program exited with ${userSignal ?? code}`
    }
    output.end()
    stderr.end()
    log.end()
    return {
        testId: options.testId,
        verdict: verdict ?? 'SE',
        timeMs: userTime,
        exitCode: code,
        signal: userSignal,
        output: output.text,
        stderr: stderr.text,
        interactorLog: log.text,
        checkerMessage: message,
        truncated: output.truncated || stderr.truncated || log.truncated
    }
}
