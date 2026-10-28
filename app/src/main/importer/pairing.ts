import { posix } from 'node:path'
import type { DetectedPair, ImportPreview } from '../../shared/importer'

export type PairingResult = Omit<ImportPreview, 'source'>
type Role = ImportPreview['extras'][number]['role']
type DataFile = { path: string; stem: string; key: string; name: string; rank: number }

const inputExtensions = new Set(['.in', '.input', '.inp', '.dat'])
const answerExtensions = ['.ans', '.out', '.ok', '.a', '.answer', '.output', '.res', '.sol', '.expected']
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

export function naturalCompare(a: string, b: string): number {
    return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0)
}

/** Paths remain relative, with portable separators. Reject traversal and Windows ADS paths. */
export function relativeEntry(path: string): string | undefined {
    const value = path.replaceAll('\\', '/').replace(/^(\.\/)+/, '')
    if (!value || value.startsWith('/') || value.includes('\0')) return undefined
    const parts = value.split('/').filter(Boolean)
    if (parts.some((part) => part === '..' || part.includes(':'))) return undefined
    return parts.filter((part) => part !== '.').join('/') || undefined
}

export function ignoredEntry(path: string): boolean {
    return path.split('/').some((part) => part.startsWith('.') || part.toLowerCase() === '__macosx')
}

export function isSampleName(name: string): boolean {
    return /(?:^|[^\p{L}])(?:samples?|examples?|ex)(?=$|[^\p{L}])/iu.test(name)
}

function extraRole(name: string): Role | undefined {
    if (/^(checker|chk|spj|check)\.(cpp|exe)$/i.test(name)) return 'checker'
    if (/^interact.*\.(cpp|exe)$/i.test(name)) return 'interactor'
    if (/^testlib\.h$/i.test(name)) return 'testlib'
    if (/^val.*\.cpp$/i.test(name)) return 'validator'
    if (/^gen.*\.cpp$/i.test(name)) return 'generator'
    if (/^(std|sol.*)\.cpp$/i.test(name)) return 'solution'
    return undefined
}

/** A marker must be a token or touch a digit: don't turn "winter" into "wter". */
function keyword(stem: string): { role: 'input' | 'answer'; name: string } | undefined {
    const match = /(^|[\d_.\-\s])(input|output|answer|expected|ans|in|out)(?=$|[\d_.\-\s])/i.exec(stem)
    if (!match) return undefined
    const start = match.index + match[1].length
    const name = (stem.slice(0, start) + stem.slice(start + match[2].length))
        .replace(/^[_.\-\s]+|[_.\-\s]+$/g, '')
        .replace(/[_.\-\s]{2,}/g, '_')
    return { role: /^(input|in)$/i.test(match[2]) ? 'input' : 'answer', name }
}

/** Pure, deterministic inference. Directory names always form part of a matching key. */
export function pairFiles(paths: string[]): PairingResult {
    const result: PairingResult = { pairs: [], unmatched: [], extras: [], notes: [] }
    const files = new Set<string>()
    for (const raw of paths) {
        if (/[\\/]$/.test(raw)) continue
        const path = relativeEntry(raw)
        if (!path) result.notes.push(`已忽略不安全路径 ${raw}`)
        else if (!ignoredEntry(path)) files.add(path)
    }

    const inputs: DataFile[] = []
    const answers: DataFile[] = []
    const bare: DataFile[] = []
    const dataPaths = new Set<string>()
    for (const path of [...files].sort(naturalCompare)) {
        const filename = posix.basename(path)
        const role = extraRole(filename)
        if (role) {
            result.extras.push({ path, role })
            continue
        }
        const extension = posix.extname(filename).toLowerCase()
        const stem = filename.slice(0, filename.length - extension.length)
        const marker = keyword(stem)
        const directory = posix.dirname(path)
        const name = marker?.name ?? stem
        const file: DataFile = {
            path,
            stem: stem.toLowerCase(),
            key: `${directory}\0${name.toLowerCase()}`,
            name: directory === '.' ? name || 'test' : `${directory}/${name || 'test'}`,
            rank: answerExtensions.indexOf(extension)
        }
        if (inputExtensions.has(extension)) inputs.push(file)
        else if (file.rank >= 0) answers.push(file)
        else if (extension === '.txt' || extension === '') {
            if (/^(readme|license|copying)(\.txt)?$/i.test(filename)) continue
            if (marker?.role === 'input') inputs.push(file)
            else if (marker?.role === 'answer') answers.push({ ...file, rank: answerExtensions.length })
            else if (!extension) bare.push(file)
        } else continue
        dataPaths.add(path)
    }

    const answerKeys = new Set(answers.map((file) => file.key))
    for (const file of bare) {
        if (
            answerKeys.has(file.key) ||
            /^(?:\d+|(?:tests?|cases?|data|samples?|examples?|ex)(?:\d|[_\-\s]|$))/i.test(file.stem)
        ) {
            inputs.push(file)
        }
    }

    const groups = new Map<string, { inputs: DataFile[]; answers: DataFile[] }>()
    for (const [kind, list] of [
        ['inputs', inputs],
        ['answers', answers]
    ] as const) {
        for (const file of list) {
            let group = groups.get(file.key)
            if (!group) groups.set(file.key, (group = { inputs: [], answers: [] }))
            group[kind].push(file)
        }
    }

    const used = new Set<string>()
    for (const group of groups.values()) {
        const selected = new Map<DataFile, DataFile>()
        const reserved = new Set<DataFile>()
        const choose = (input: DataFile, candidates: DataFile[]): void => {
            candidates.sort((a, b) => a.rank - b.rank || naturalCompare(a.path, b.path))
            selected.set(input, candidates[0])
            candidates.forEach((file) => reserved.add(file))
            if (candidates.length > 1) {
                result.notes.push(
                    `${input.path} 同时有 ${candidates.map((file) => file.path).join(' 和 ')}，已采用 ${candidates[0].path}`
                )
            }
        }
        // Preserve exact stems before trying keyword aliases; never reuse an answer.
        for (const input of group.inputs) {
            const exact = group.answers.filter((file) => file.stem === input.stem && !reserved.has(file))
            if (exact.length) choose(input, exact)
        }
        const remaining = group.inputs.filter((input) => !selected.has(input))
        const available = group.answers.filter((file) => !reserved.has(file))
        if (remaining.length === 1 && available.length) choose(remaining[0], available)
        else if (remaining.length > 1 && available.length) {
            result.notes.push(`${remaining.map((file) => file.path).join('、')} 配对不明确，答案未匹配`)
        }
        for (const input of group.inputs) {
            const answer = selected.get(input)?.path
            const pair: DetectedPair = { name: input.name, input: input.path }
            if (answer !== undefined) pair.answer = answer
            result.pairs.push(pair)
            used.add(input.path)
            if (answer) used.add(answer)
        }
    }

    result.pairs.sort(
        (a, b) =>
            Number(isSampleName(b.name)) - Number(isSampleName(a.name)) ||
            naturalCompare(a.name, b.name) ||
            naturalCompare(a.input, b.input)
    )
    result.unmatched = [...dataPaths].filter((path) => !used.has(path)).sort(naturalCompare)
    const missing = result.pairs.filter((pair) => pair.answer === undefined).length
    if (missing) result.notes.push(`${missing} 个输入没有答案，仍可导入`)
    for (const role of ['checker', 'interactor'] as const) {
        const candidates = result.extras.filter((extra) => extra.role === role)
        if (candidates.length > 1)
            result.notes.push(`多个${role === 'checker' ? '检查器' : '交互器'}，附加时采用 ${candidates[0].path}`)
    }
    if (
        result.extras.some((extra) => extra.role === 'checker') &&
        result.extras.some((extra) => extra.role === 'interactor')
    ) {
        result.notes.push('同时附加检查器和交互器时，采用交互模式')
    }
    result.notes.sort(naturalCompare)
    return result
}
