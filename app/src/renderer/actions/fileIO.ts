import type { FileIOConfig, ProblemConfig } from '../../shared/problem'
import { detectFreopen } from '../editor/freopen'
import { toast } from '../state/app'
import { saveProblemSettings } from './problemWrites'

/** Older automatic settings have no origin tag; keep following the code until
 * the user explicitly edits file IO. Retain file names when disabling it. */
export function fileIOFromCode(code: string, io: FileIOConfig, force = false): FileIOConfig {
    const detected = detectFreopen(code)
    if (detected.input || detected.output)
        return {
            enabled: true,
            input: detected.input ?? io.input,
            output: detected.output ?? io.output,
            origin: 'freopen'
        }
    if (!force && io.origin === 'manual') return io
    return { ...io, enabled: false, origin: 'freopen' }
}

export async function syncFileIO(path: string, code: string, problem: ProblemConfig, force = false): Promise<void> {
    // Interactive execution uses pipes; do not overwrite the remembered ordinary-run file settings.
    if (problem.mode === 'interactive') return
    const previous = problem.fileIO
    const next = fileIOFromCode(code, previous, force)
    // An untouched standard-IO problem needs no provenance-only write.
    if (
        previous.enabled === next.enabled &&
        previous.input === next.input &&
        previous.output === next.output &&
        (previous.origin === next.origin || (!previous.enabled && !previous.origin && !force))
    )
        return
    await saveProblemSettings(path, { fileIO: next })
    if (!next.enabled && previous.enabled) toast('未检测到启用的 freopen，已关闭文件 IO', 'info', 5000)
    else if (next.enabled && (!previous.enabled || previous.input !== next.input || previous.output !== next.output))
        toast(`检测到 freopen，已按 ${next.input} / ${next.output} 开启文件 IO`, 'info', 5000)
}
