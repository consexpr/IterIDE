import { createReadStream, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveBuiltin, type BuiltinChecker, type CheckerRef, type CheckerValue } from '../../shared/problem'
import type { ToolchainSettings, Verdict } from '../../shared/judge'
import { compileSource, digest } from './compile'
import { splitArgs } from '../toolchain/args'
import { execute } from './process'
import { getPassthroughRunner } from './runner'
import { resourceFile } from './resources'
import { atomicWrite } from '../problem/store'
import { holdCachePath } from './cache-lru'
import { equalToken as equal, equalLine as lineEqual } from '../../shared/checkerComparison'

export interface CheckResult {
    verdict: Verdict
    checkerMessage?: string
}
interface Unit {
    text: string
    line: number
    token: number
}

async function* tokens(file: string): AsyncGenerator<Unit> {
    const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 16_384 })
    let text = '',
        line = 1,
        token = 0,
        startLine = 1,
        startToken = 1
    try {
        for await (const chunk of stream) {
            for (const part of (chunk as string).match(/\s+|\S+/g) ?? []) {
                if (/^\s/.test(part)) {
                    if (text) {
                        yield { text, line: startLine, token: startToken }
                        text = ''
                    }
                    for (const char of part)
                        if (char === '\n') {
                            line++
                            token = 0
                        }
                } else {
                    if (!text) {
                        startLine = line
                        startToken = ++token
                    }
                    text += part
                }
            }
        }
        if (text) yield { text, line: startLine, token: startToken }
    } finally {
        stream.destroy()
    }
}

async function* lines(file: string): AsyncGenerator<Unit> {
    const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 16_384 })
    let buffer = '',
        row = 0,
        blank = 0
    function* consume(raw: string): Generator<Unit> {
        row++
        const text = raw.replace(/[\t \r]+$/, '')
        if (!text) {
            blank++
            return
        }
        for (let i = row - blank; i < row; i++) yield { text: '', line: i, token: 1 }
        blank = 0
        yield { text, line: row, token: 1 }
    }
    try {
        for await (const chunk of stream) {
            buffer += chunk as string
            let end: number
            while ((end = buffer.indexOf('\n')) >= 0) {
                for (const unit of consume(buffer.slice(0, end))) yield unit
                buffer = buffer.slice(end + 1)
            }
        }
        if (buffer) for (const unit of consume(buffer)) yield unit
    } finally {
        stream.destroy()
    }
}

/** Every line exactly as written (newlines normalised), including a final empty one after a trailing newline. */
async function* rawLines(file: string): AsyncGenerator<Unit> {
    let rest = '',
        row = 0
    for await (const chunk of normalized(file)) {
        rest += chunk
        let end: number
        while ((end = rest.indexOf('\n')) >= 0) {
            yield { text: rest.slice(0, end), line: ++row, token: 1 }
            rest = rest.slice(end + 1)
        }
    }
    yield { text: rest, line: ++row, token: 1 }
}

async function* normalized(file: string): AsyncGenerator<string> {
    const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 16_384 })
    let cr = false
    try {
        for await (const chunk of stream) {
            let text: string = (cr ? '\r' : '') + chunk
            cr = text.endsWith('\r')
            if (cr) text = text.slice(0, -1)
            text = text.replace(/\r\n/g, '\n')
            if (text) yield text
        }
        if (cr) yield '\r'
    } finally {
        stream.destroy()
    }
}

async function exact(output: string, answer: string, signal?: AbortSignal): Promise<CheckResult> {
    const actual = normalized(output),
        expected = normalized(answer)
    let a = '',
        b = '',
        aDone = false,
        bDone = false,
        row = 1,
        column = 1
    try {
        while (true) {
            if (signal?.aborted) return { verdict: 'SE', checkerMessage: 'Stopped' }
            if (!a && !aDone) {
                const n = await actual.next()
                a = n.value ?? ''
                aDone = !!n.done
            }
            if (!b && !bDone) {
                const n = await expected.next()
                b = n.value ?? ''
                bDone = !!n.done
            }
            if (!a && !b && aDone && bDone) return { verdict: 'AC' }
            if ((!a && aDone) || (!b && bDone))
                return {
                    verdict: 'WA',
                    checkerMessage: `line ${row}, column ${column}: expected ${JSON.stringify(b[0] ?? '<EOF>')}, found ${JSON.stringify(a[0] ?? '<EOF>')}`
                }
            const length = Math.min(a.length, b.length)
            for (let i = 0; i < length; i++) {
                if (a[i] !== b[i])
                    return {
                        verdict: 'WA',
                        checkerMessage: `line ${row}, column ${column}: expected ${JSON.stringify(b[i])}, found ${JSON.stringify(a[i])}`
                    }
                if (b[i] === '\n') {
                    row++
                    column = 1
                } else column++
            }
            a = a.slice(length)
            b = b.slice(length)
        }
    } finally {
        await actual.return(undefined)
        await expected.return(undefined)
    }
}

export async function builtinCheck(
    output: string,
    answer: string,
    checker: BuiltinChecker = 'tokens',
    signal?: AbortSignal,
    valueRule?: CheckerValue
): Promise<CheckResult> {
    const { layout, value } = resolveBuiltin(checker, valueRule)
    if (layout === 'exact' && value === 'text') return exact(output, answer, signal)
    const units = layout === 'tokens' ? tokens : layout === 'lines' ? lines : rawLines
    const same =
        layout === 'tokens'
            ? (a: string, b: string) => equal(a, b, value)
            : (a: string, b: string) => lineEqual(a, b, value)
    const actual = units(output)
    const expected = units(answer)
    let position = { line: 1, token: 1 }
    try {
        while (!signal?.aborted) {
            const [a, b] = await Promise.all([actual.next(), expected.next()])
            if (a.done && b.done) return { verdict: 'AC' }
            if (b.value) position = b.value
            if (a.done || b.done || !same(a.value.text, b.value.text)) {
                const short = (s: string): string => JSON.stringify(s.length > 100 ? s.slice(0, 100) + '…' : s)
                return {
                    verdict: 'WA',
                    checkerMessage: `line ${position.line}, token ${position.token}: expected ${short(b.value?.text ?? '<EOF>')}, found ${short(a.value?.text ?? '<EOF>')}`
                }
            }
            position = { line: position.line, token: position.token + 1 }
        }
        return { verdict: 'SE', checkerMessage: 'Stopped' }
    } finally {
        await actual.return(undefined)
        await expected.return(undefined)
    }
}

export function checkerVerdict(code: number | null, message: string): CheckResult {
    const verdict: Verdict = code === 0 || code === 7 ? 'AC' : code === 1 ? 'WA' : code === 2 ? 'PE' : 'SE'
    return {
        verdict,
        checkerMessage:
            message.trim() ||
            (code === 7 ? 'Checker awarded points' : code === 0 ? undefined : `Checker exited with code ${code}`)
    }
}

export function checkerArgs(
    template: string | undefined,
    files: { input: string; output: string; answer: string; score: string }
): string[] {
    return splitArgs(template ?? '{input} {output} {answer}').map((arg) =>
        arg.replace(
            /\{(input|output|answer|score\??)\}/g,
            (_, key: string) => files[key.replace('?', '') as keyof typeof files]
        )
    )
}

export async function prepareTool(
    base: string,
    relative: string | undefined,
    tc: ToolchainSettings,
    signal?: AbortSignal,
    files: string[] = []
): Promise<string> {
    if (!relative) throw new Error('Checker/interactor path is not configured')
    const file = path.resolve(base, relative)
    await fs.access(file)
    if (!/\.(?:c|cc|cpp|cxx)$/i.test(file)) return file
    const source = await fs.readFile(file, 'utf8')
    // Always make testlib available, including indirect or macro-based includes. This does not include it.
    const header = await fs
        .readFile(path.join(path.dirname(file), 'testlib.h'), 'utf8')
        .catch(async (error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
            return fs.readFile(await resourceFile('testlib/testlib.h'), 'utf8')
        })
    const stage = path.join(os.tmpdir(), 'iter-build', 'tools', digest(source + header))
    const release = holdCachePath(stage)
    try {
        await fs.mkdir(stage, { recursive: true })
        await atomicWrite(path.join(stage, 'testlib.h'), header)
        // Older exam testlib versions rely on transitive fixed-width integer declarations.
        const result = await compileSource(
            file,
            source,
            { ...tc, flags: '-std=c++17 -O2 -include cstdint' },
            false,
            '',
            signal,
            [...files.map((name) => path.dirname(path.resolve(base, name))), stage],
            {
                sources: files
                    .filter((name) => /\.(?:c|cc|cpp|cxx)$/i.test(name))
                    .map((name) => path.resolve(base, name))
            }
        )
        if (!result.ok || !result.exe) throw new Error(`Cannot compile checker/interactor:\n${result.output}`)
        return result.exe
    } finally {
        release()
    }
}

export async function customCheck(
    exe: string,
    checker: CheckerRef,
    files: { input: string; output: string; answer: string; score: string },
    tc: ToolchainSettings,
    signal: AbortSignal
): Promise<CheckResult> {
    const runner = await getPassthroughRunner(tc, signal)
    const result = await execute(exe, checkerArgs(checker.args, files), {
        runner,
        cwd: path.dirname(files.output),
        timeout: 10_000,
        signal,
        displayLimit: tc.displayLimitChars,
        outputLimit: tc.outputLimitBytes
    })
    if (result.error || result.timedOut || result.outputExceeded || signal.aborted)
        return {
            verdict: 'SE',
            checkerMessage:
                result.error ??
                (result.timedOut
                    ? 'Checker timed out after 10 seconds'
                    : result.outputExceeded
                      ? 'Checker output limit exceeded'
                      : 'Stopped')
        }
    return checkerVerdict(result.code, result.stderr || result.stdout)
}
