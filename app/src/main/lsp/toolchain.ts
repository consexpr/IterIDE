import { execute } from '../judge/process'

/** Also supports clangd builds with incomplete Windows query-driver support. */
export async function probeCompiler(compiler: string, signal?: AbortSignal): Promise<string[]> {
    const result = await execute(compiler, ['-E', '-x', 'c++', '-', '-v'], {
        timeout: 5000,
        signal,
        outputLimit: 1024 * 1024,
        displayLimit: 1024 * 1024
    })
    if (signal?.aborted || result.error || result.timedOut || result.outputExceeded) return []
    const output = result.stdout + result.stderr
    const block = /#include <\.\.\.> search starts here:([\s\S]*?)End of search list\./.exec(output)?.[1] ?? ''
    const includes = block
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/ \(framework directory\)$/, ''))
        .filter(Boolean)
    const target = /^Target:\s*(\S+)/m.exec(output)?.[1]
    return [...(target ? [`--target=${target}`] : []), ...includes.flatMap((include) => ['-isystem', include])]
}
