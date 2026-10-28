import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CompileResult, Diagnostic, ToolchainSettings } from '../../shared/judge'
import type { ProblemConfig } from '../../shared/problem'
import { rewriteResourceIncludes } from '../problem/resources'
import { resourceContext, rewriteRuntimeStrings } from '../problem/resourceRuntime'
import { graderInputs } from '../problem/grader'
import { cancellable, execute } from './process'
import { parseDiagnostics } from './diagnostics'
import { splitArgs } from '../toolchain/args'
import { sourceCompileContext } from '../toolchain/context'
import { resolveCompiler, resolveTool } from '../toolchain'
import type { ModeBuildPlan } from './modes/registry'
import { parseDepfile } from './depfile'
import { holdCachePath, pruneBuildCache } from './cache-lru'

export const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
export const executableName = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name)
const builds = new Map<string, Promise<CompileResult>>()
interface Manifest {
    version: 2
    key: string
    cacheable?: boolean
    lastUsed: number
    dependencies: [string, string][]
    output: string
    diagnostics: Diagnostic[]
}
const fileDigest = async (file: string): Promise<string> =>
    createHash('sha256')
        .update(await fs.readFile(file))
        .digest('hex')
const stopped = (): CompileResult => ({ ok: false, output: 'Stopped', diagnostics: [], timeMs: 0, cached: false })
/** Preprocessor depfiles do not describe linker inputs. Until library/script/
 * response resolution has its own manifest, compile these configurations every
 * time instead of claiming that an unchanged header set makes them reusable. */
function reusableLinkInputs(flags: string[]): boolean {
    return !flags.some(
        (flag) =>
            /^-(?:l|L|F)/.test(flag) ||
            /^-Wl(?:,|$)/.test(flag) ||
            /^(?:-Xlinker|-T|--script|-specs|--sysroot|-isysroot|-B|-framework)(?:$|=|.+)/.test(flag) ||
            /^-(?:fplugin|fuse-ld)(?:$|=)/.test(flag) ||
            /^-static(?:$|-)/.test(flag) ||
            flag.startsWith('@') ||
            /\.(?:a|o|obj|so(?:\.\d+)*|dylib|lib|dll|ld|lds|def|res|exp)$/i.test(flag)
    )
}

async function cachedBuild(
    base: string,
    key: string,
    validate: (dir: string, manifest: Manifest) => Promise<boolean>,
    signal?: AbortSignal
): Promise<CompileResult | undefined> {
    const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('build-')) continue
        const dir = path.join(base, entry.name),
            exe = path.join(dir, executableName('program'))
        try {
            const manifest = JSON.parse(await fs.readFile(path.join(dir, 'compile.json'), 'utf8')) as Manifest
            if (
                manifest.version !== 2 ||
                manifest.key !== key ||
                manifest.cacheable === false ||
                !Array.isArray(manifest.dependencies)
            )
                continue
            if (!(await fs.stat(exe)).isFile()) continue
            if (!(await validate(dir, manifest))) continue
            let valid = true
            for (const [file, expected] of manifest.dependencies) {
                if (signal?.aborted) return undefined
                if ((await fileDigest(file)) !== expected) {
                    valid = false
                    break
                }
            }
            if (!valid) continue
            manifest.lastUsed = Date.now()
            const update = path.join(dir, `access-${randomUUID()}.json`)
            await fs.writeFile(update, JSON.stringify(manifest))
            await fs.rename(update, path.join(dir, 'compile.json'))
            return {
                ok: true,
                exe,
                output: manifest.output,
                diagnostics: manifest.diagnostics,
                timeMs: 0,
                cached: true
            }
        } catch {
            /* A changed/deleted dependency or incomplete entry is a cache miss. */
        }
    }
    return undefined
}

export async function compileSource(
    src: string,
    source: string,
    tc: ToolchainSettings,
    debug: boolean,
    extra = '',
    signal?: AbortSignal,
    includes: string[] = [],
    grader?: ProblemConfig['grader'],
    plan?: ModeBuildPlan
): Promise<CompileResult> {
    source = rewriteResourceIncludes(source, plan?.sourceHeaders ?? {})
    source = rewriteRuntimeStrings(
        source,
        Object.fromEntries(
            Object.entries(plan?.sourceRuntime ?? {}).map(([name, file]) => [
                name,
                JSON.stringify(file.replaceAll('\\', '/'))
            ])
        )
    )
    const originalDirectory = sourceCompileContext(src, []).cwd
    const cwd = await fs.stat(originalDirectory).then(
        (info) => (info.isDirectory() ? originalDirectory : os.tmpdir()),
        () => os.tmpdir()
    )
    let compiler: string
    let flags: string[]
    let units: ReturnType<typeof graderInputs>, contents: string[]
    let compilerIdentity: string
    try {
        const resolved = resolveCompiler(tc, [
            ...splitArgs(debug ? tc.debugFlags : tc.flags),
            ...(debug ? ['-g'] : []),
            ...splitArgs(extra),
            ...(plan?.flags ?? [])
        ])
        compiler = resolved.command
        flags = resolved.flags
        compilerIdentity = await fileDigest(compiler)
        units = graderInputs(src, plan ? { sources: plan.sources ?? [], includeDirs: plan.includeDirs } : grader)
        const resources = await resourceContext([
            src,
            ...units.sources,
            ...units.includeDirs,
            ...includes,
            ...Object.values(plan?.sourceHeaders ?? {}),
            ...Object.values(plan?.sourceRuntime ?? {})
        ])
        flags.push(...resources.flags)
        includes = [...new Set([...includes, ...resources.includeDirs])]
        contents = await Promise.all(
            units.sources.map(async (file) => {
                try {
                    return await fs.readFile(file, 'utf8')
                } catch (error) {
                    throw new Error(`Cannot read grader source ${file}: ${(error as Error).message}`)
                }
            })
        )
    } catch (error) {
        return { ok: false, output: (error as Error).message, diagnostics: [], timeMs: 0, cached: false }
    }
    const reusable = reusableLinkInputs(flags)
    const hash = digest(JSON.stringify([source, flags, compiler, compilerIdentity, includes, units, contents]))
    const sourceHash = digest(path.resolve(src)),
        cacheKey = digest(JSON.stringify([path.resolve(src), hash]))
    // Keep native Windows compiler/runner paths below MAX_PATH even when TEMP is
    // deeply nested. Full keys stay in the manifest; directory prefixes cannot
    // cause an unrelated source/build to be accepted as a cache hit.
    const base = path.join(os.tmpdir(), 'iter-build', sourceHash.slice(0, 16), hash.slice(0, 16))
    const pending = builds.get(base)
    if (pending) {
        await cancellable(pending, signal)
        if (signal?.aborted) return stopped()
        return compileSource(src, source, tc, debug, extra, signal, includes, grader, plan)
    }
    const build = async (): Promise<CompileResult> => {
        const release = holdCachePath(base)
        let dir: string | undefined
        try {
            if (signal?.aborted) return stopped()
            const cached = reusable
                ? await cachedBuild(
                      base,
                      cacheKey,
                      async (entry, manifest) => {
                          // Re-probe actual include resolution. Adding a higher-priority shadow
                          // header changes dependencies even when all old files remain unchanged.
                          const probe = await fs.mkdtemp(path.join(base, '.probe-'))
                          const input = path.join(entry, 'source.cpp')
                          const actual = new Set<string>()
                          try {
                              for (const [index, unit] of [input, ...units.sources].entries()) {
                                  const depfile = path.join(probe, `${index}.d`)
                                  const result = await execute(
                                      compiler,
                                      [
                                          ...flags,
                                          ...[...units.includeDirs, ...includes].flatMap((p) => ['-I', p]),
                                          '-M',
                                          '-MF',
                                          depfile,
                                          '-MT',
                                          'iter-object',
                                          unit
                                      ],
                                      { cwd, timeout: 10_000, signal }
                                  )
                                  if (
                                      result.code !== 0 ||
                                      result.error ||
                                      result.timedOut ||
                                      result.outputExceeded ||
                                      signal?.aborted
                                  )
                                      return false
                                  for (const file of parseDepfile(await fs.readFile(depfile, 'utf8'))) {
                                      const absolute = path.resolve(path.dirname(path.resolve(src)), file)
                                      if (absolute !== input) actual.add(absolute)
                                  }
                              }
                              return (
                                  actual.size === manifest.dependencies.length &&
                                  manifest.dependencies.every(([file]) => actual.has(file))
                              )
                          } finally {
                              await fs.rm(probe, { recursive: true, force: true })
                          }
                      },
                      signal
                  )
                : undefined
            if (signal?.aborted) return stopped()
            if (cached) return cached
            await fs.mkdir(base, { recursive: true })
            dir = await fs.mkdtemp(path.join(base, '.building-'))
            const input = path.join(dir, 'source.cpp')
            const mapped = path.resolve(src).replaceAll('\\', '/').replaceAll('"', '\\"')
            await fs.writeFile(input, `#line 1 "${mapped}"\n${source}`)
            const exe = path.join(dir, executableName('program')),
                objects: string[] = [],
                dependencies = new Set<string>()
            let output = '',
                timeMs = 0,
                ok = true
            const buildStarted = Date.now()
            const run = async (args: string[]): Promise<boolean> => {
                const result = await execute(compiler, args, { cwd, timeout: 30_000, signal })
                timeMs += result.timeMs
                output += result.stdout + result.stderr
                if (result.error) output += `\n${result.error}`
                if (result.timedOut) output += '\nCompilation timed out after 30 seconds'
                if (result.outputExceeded) output += '\nCompiler output limit exceeded'
                return (
                    result.code === 0 && !result.error && !result.timedOut && !result.outputExceeded && !signal?.aborted
                )
            }
            // One depfile per translation unit: a single -MF on a multi-source driver
            // invocation otherwise retains only the final translation unit's headers.
            for (const [index, unit] of [input, ...units.sources].entries()) {
                const object = path.join(dir, `unit-${index}.o`),
                    depfile = path.join(dir, `unit-${index}.d`)
                ok = await run([
                    ...flags,
                    '-fdiagnostics-color=never',
                    ...[...units.includeDirs, ...includes].flatMap((p) => ['-I', p]),
                    '-MD',
                    '-MF',
                    depfile,
                    '-MT',
                    'iter-object',
                    '-c',
                    unit,
                    '-o',
                    object
                ])
                if (!ok) break
                objects.push(object)
                for (const file of parseDepfile(await fs.readFile(depfile, 'utf8'))) {
                    const absolute = path.resolve(path.dirname(path.resolve(src)), file)
                    if (absolute !== input) dependencies.add(absolute)
                }
            }
            if (ok) ok = await run([...objects, ...flags, '-o', exe])
            const diagnostics = parseDiagnostics(output, input, src)
            if (!ok || signal?.aborted)
                return { ok: false, output: signal?.aborted ? 'Stopped' : output, diagnostics, timeMs, cached: false }
            let cacheable = reusable
            const dependencyHashes: [string, string][] = []
            for (const file of [...dependencies].sort()) {
                const before = await fs.stat(file),
                    hash = await fileDigest(file),
                    after = await fs.stat(file)
                // Never pair an executable compiled against an earlier header with a
                // hash observed after the editor changed that header during compilation.
                if (after.mtimeMs >= buildStarted || before.mtimeMs !== after.mtimeMs || before.size !== after.size)
                    cacheable = false
                dependencyHashes.push([file, hash])
            }
            const manifest: Manifest = {
                version: 2,
                key: cacheKey,
                cacheable,
                lastUsed: Date.now(),
                dependencies: dependencyHashes,
                output,
                diagnostics
            }
            if (signal?.aborted) return stopped()
            await fs.writeFile(path.join(dir, 'compile.json'), JSON.stringify(manifest))
            await Promise.all(objects.map((file) => fs.rm(file, { force: true })))
            if (signal?.aborted) return stopped()
            const published = path.join(base, `build-${randomUUID()}`)
            await fs.rename(dir, published)
            if (signal?.aborted) {
                await fs.rm(published, { recursive: true, force: true })
                return stopped()
            }
            return {
                ok: true,
                exe: path.join(published, executableName('program')),
                output,
                diagnostics,
                timeMs,
                cached: false
            }
        } catch (error) {
            return { ok: false, output: (error as Error).message, diagnostics: [], timeMs: 0, cached: false }
        } finally {
            if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
            release()
            // Run after awaiting callers have acquired their executable leases.
            const timer = setTimeout(() => {
                void pruneBuildCache().catch(() => {})
            }, 0)
            timer.unref()
        }
    }
    const promise = build()
    builds.set(base, promise)
    try {
        return await promise
    } finally {
        if (builds.get(base) === promise) builds.delete(base)
    }
}

export async function checkSyntax(
    src: string,
    source: string,
    tc: ToolchainSettings,
    signal: AbortSignal,
    compileArgs?: string[]
): Promise<Diagnostic[]> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-syntax-'))
    const input = path.join(dir, 'source.cpp')
    try {
        let compiler: string
        try {
            compiler = resolveTool('compiler', tc).command
        } catch (error) {
            return signal.aborted
                ? []
                : [
                      {
                          file: src,
                          line: 1,
                          column: 1,
                          severity: 'error',
                          message: (error as Error).message,
                          source: 'g++'
                      }
                  ]
        }
        await fs.writeFile(input, source)
        const context = sourceCompileContext(src, compileArgs ?? splitArgs(tc.flags))
        const flags = context.args
        const cwd = await fs.stat(context.cwd).then(
            (info) => (info.isDirectory() ? context.cwd : os.tmpdir()),
            () => os.tmpdir()
        )
        const result = await execute(
            compiler,
            [
                ...flags,
                '-Wall',
                '-fsyntax-only',
                '-fdiagnostics-color=never',
                '-I',
                path.dirname(path.resolve(src)),
                input
            ],
            { cwd, timeout: 10_000, signal }
        )
        if (signal.aborted) return []
        const diagnostics = parseDiagnostics(result.stdout + result.stderr, input, src)
        if (result.error || result.timedOut)
            diagnostics.push({
                file: src,
                line: 1,
                column: 1,
                severity: 'error',
                message: result.error ?? 'Syntax check timed out after 10 seconds',
                source: 'g++'
            })
        return diagnostics
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
}
