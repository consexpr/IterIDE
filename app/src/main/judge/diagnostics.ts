import path from 'node:path'
import type { Diagnostic } from '../../shared/judge'

export function parseDiagnostics(output: string, temporary: string, original: string): Diagnostic[] {
    const result: Diagnostic[] = []
    for (const line of output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
        const match = /^(.*?):(\d+):(\d+):\s*(fatal error|error|warning|note):\s*(.*)$/.exec(line)
        if (!match) continue
        const [, file, row, column, kind, message] = match
        if (kind === 'note' && result.length) {
            result[result.length - 1].message += `\nnote: ${message}`
            continue
        }
        const key = (name: string): string =>
            process.platform === 'win32' ? path.resolve(name).toLowerCase() : path.resolve(name)
        result.push({
            file: key(file) === key(temporary) || key(file) === key(original) ? original : file,
            line: Number(row),
            column: Number(column),
            severity: kind.includes('error') ? 'error' : kind === 'warning' ? 'warning' : 'info',
            message,
            source: 'g++'
        })
    }
    return result
}
