import path from 'node:path'
import type { ProblemConfig } from '../../shared/problem'

/** Both judge and debugger compile the same translation units and header search paths. */
export function graderInputs(
    sourcePath: string,
    grader?: ProblemConfig['grader']
): { sources: string[]; includeDirs: string[] } {
    const source = path.resolve(sourcePath),
        base = path.dirname(source)
    const key = (file: string): string => (process.platform === 'win32' ? file.toLowerCase() : file)
    const unique = (files: string[]): string[] => [...new Map(files.map((file) => [key(file), file])).values()]
    const sources = unique((grader?.sources ?? []).map((file) => path.resolve(base, file)))
    if (sources.some((file) => key(file) === key(source)))
        throw new Error('Grader sources must not include the user solution itself')
    return {
        sources,
        includeDirs: unique([base, ...(grader?.includeDirs ?? []).map((dir) => path.resolve(base, dir))])
    }
}
