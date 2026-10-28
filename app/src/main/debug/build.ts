import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DebugStartRequest } from '../../shared/debug'
import type { ToolchainSettings } from '../../shared/judge'
import { loadProblem, testDataPaths } from '../problem/store'
import { buildPlanFor, planArgs } from '../judge/flags'
import { runProcess } from './process'
import { resolveCompiler } from '../toolchain'
import { sourceCompileContext } from '../toolchain/context'

const prelude = `#pragma once
#include <stdio.h>
#include <stdlib.h>
namespace iter_debug_private {
struct Redirect {
  Redirect() {
    const char *p;
    if ((p = getenv("ITER_STDIN")) && *p) freopen(p, "rb", stdin);
    if ((p = getenv("ITER_STDOUT")) && *p) freopen(p, "wb", stdout);
    if ((p = getenv("ITER_STDERR")) && *p) freopen(p, "wb", stderr);
    setvbuf(stdout, 0, _IONBF, 0);
    setvbuf(stderr, 0, _IONBF, 0);
  }
};
static Redirect redirect;
}
`

// MinGW GDB 10 blocks its MI input loop while the inferior runs. Interrupt the
// inferior through the Windows debug API, rather than killing GDB with SIGINT.
const windowsInterrupt = `#include <windows.h>
#include <stdlib.h>
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  HANDLE process = OpenProcess(PROCESS_ALL_ACCESS, FALSE, strtoul(argv[1], 0, 10));
  if (!process) return 3;
  BOOL ok = DebugBreakProcess(process);
  CloseHandle(process);
  return ok ? 0 : 4;
}
`

export interface DebugBuild {
    dir: string
    cwd: string
    exe: string
    sourcePath: string
    sourceFiles: string[]
    inputPath: string
    stdoutPath: string
    stderrPath: string
    interruptExe?: string
    fileInput?: string
    fileOutput?: string
}

export function insideDirectory(root: string, filename: string): string {
    const target = path.resolve(root, filename)
    const relative = path.relative(root, target)
    if (
        !filename ||
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative) ||
        target === root
    ) {
        throw new Error(`Debug file path must stay inside its run directory: ${filename}`)
    }
    return target
}

export async function removeBuild(dir: string): Promise<void> {
    // Only delete a verified mkdtemp child, never a source/problem directory.
    if (path.dirname(dir) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('iter-debug-')) {
        throw new Error('Refusing to remove an invalid debug build directory')
    }
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

export async function buildDebug(
    req: DebugStartRequest,
    toolchain: ToolchainSettings,
    signal: AbortSignal
): Promise<DebugBuild> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-debug-'))
    try {
        const { sourcePath, cwd: sourceDir } = sourceCompileContext(req.sourcePath, [])
        const config = await loadProblem(sourcePath)
        const { fileIO } = config
        const units = await buildPlanFor(sourcePath, config)
        const compiler = resolveCompiler(toolchain, planArgs(toolchain.debugFlags, config, units))
        let input = req.input ?? ''
        if (req.input === undefined && req.testId !== undefined) {
            const test = config.tests.find((test) => test.id === req.testId)
            if (!test) throw new Error(`Debug test not found: ${req.testId}`)
            const inputFile = testDataPaths(sourcePath, test).input
            input = await fs.readFile(inputFile, 'utf8')
        }
        const cwd = path.join(dir, 'run')
        await fs.mkdir(cwd)
        const inputPath = path.join(dir, 'stdin.txt')
        const stdoutPath = path.join(dir, 'stdout.txt'),
            stderrPath = path.join(dir, 'stderr.txt')
        const sourceFile = path.join(dir, 'editor.cpp'),
            header = path.join(dir, 'prelude.h')
        const exe = path.join(dir, process.platform === 'win32' ? 'program.exe' : 'program')
        const mappedPath = sourcePath.replace(/\\/g, '/').replace(/"/g, '\\"')
        await Promise.all([
            fs.writeFile(sourceFile, `#line 1 "${mappedPath}"\n${req.source}`, 'utf8'),
            fs.writeFile(header, prelude, 'utf8'),
            fs.writeFile(inputPath, input, 'utf8'),
            fs.writeFile(stdoutPath, ''),
            fs.writeFile(stderrPath, '')
        ])
        let fileOutput: string | undefined, fileInput: string | undefined
        if (fileIO?.enabled) {
            fileInput = insideDirectory(cwd, fileIO.input)
            fileOutput = insideDirectory(cwd, fileIO.output)
            if (fileInput === fileOutput) throw new Error('File IO input and output must be different files')
            await Promise.all([
                fs.mkdir(path.dirname(fileInput), { recursive: true }),
                fs.mkdir(path.dirname(fileOutput), { recursive: true })
            ])
            await fs.copyFile(inputPath, fileInput)
        }
        const result = await runProcess(
            compiler.command,
            [...compiler.flags, '-g', '-O0', '-include', header, sourceFile, ...(units.sources ?? []), '-o', exe],
            { cwd: sourceDir, signal }
        )
        if (result.code !== 0) throw new Error(result.output || `Compiler exited with code ${result.code}`)
        let interruptExe: string | undefined
        if (process.platform === 'win32') {
            const helper = path.join(dir, 'interrupt.cpp')
            interruptExe = path.join(dir, 'interrupt.exe')
            await fs.writeFile(helper, windowsInterrupt)
            const interruptCompiler = resolveCompiler(toolchain, [])
            const compiled = await runProcess(
                interruptCompiler.command,
                [...interruptCompiler.flags, helper, '-o', interruptExe],
                { signal }
            )
            if (compiled.code !== 0) throw new Error(`Cannot build Windows debug interrupt helper:\n${compiled.output}`)
        }
        signal.throwIfAborted()
        return {
            dir,
            cwd,
            exe,
            sourcePath,
            sourceFiles: [sourcePath, ...(units.sources ?? [])],
            inputPath,
            stdoutPath,
            stderrPath,
            fileOutput,
            fileInput,
            interruptExe
        }
    } catch (error) {
        await removeBuild(dir)
        throw error
    }
}
