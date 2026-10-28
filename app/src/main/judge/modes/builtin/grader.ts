import path from 'node:path'
import { promises as fs } from 'node:fs'
import type { JudgeModePlugin } from '../registry'
import { functionNames, headerKey, scanCpp } from '../../../importer/source-analysis'
import { describeBase, fileBadge, prepareShared, runShared, solutionBuild, toolBadges } from './common'

export const graderMode: JudgeModePlugin = {
    id: 'grader',
    name: '函数式评测',
    description: '将 grader 与解答一起编译链接',
    settingsSchema: [
        { key: 'grader.sources', label: 'Grader 源码', type: 'file', required: true },
        { key: 'grader.includeDirs', label: '头文件目录', type: 'text' }
    ],
    detect(folder) {
        const cpp = folder.files.filter((file) => /\.cpp$/i.test(file))
        const headers = folder.files.filter((file) => /\.(h|hh|hpp|hxx)$/i.test(file))
        const templates = cpp.filter((file) => /^(?:template_.*|.*_template.*)\.cpp$/i.test(file))
        const scans = new Map([...cpp, ...headers].map((file) => [file, scanCpp(folder.peek(file) ?? '')]))
        const definitions = new Map(cpp.map((file) => [file, functionNames(scans.get(file)!.body, 'definition')]))
        const headerNames = new Set(headers.map(headerKey))
        const templateHeaders = new Set(
            templates
                .flatMap((file) => scans.get(file)!.includes.map(headerKey))
                .filter((file) => headerNames.has(file))
        )
        const templateFunctions = headers
            .filter((file) => templateHeaders.has(headerKey(file)))
            .flatMap((file) => [...functionNames(scans.get(file)!.body, 'declaration')])
        const candidates = cpp.filter(
            (file) => !templates.includes(file) && !/^(checker|chk\.|spj\.|check\.|interact|val|gen)/i.test(file)
        )
        const named = candidates.filter((file) => /^grader.*\.cpp$/i.test(file))
        const graders = named.length
            ? named
            : candidates.filter((file) => {
                  const scan = scans.get(file)!
                  return (
                      definitions.get(file)!.has('main') &&
                      (scan.includes.some((header) => templateHeaders.has(headerKey(header))) ||
                          templateFunctions.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(scan.body)))
                  )
              })
        if (!graders.length) return undefined
        const notes = [`函数式评测：与 ${graders.join('、')} 一同编译`]
        const declarations = new Set(
            headers.flatMap((file) => [...functionNames(scans.get(file)!.body, 'declaration')])
        )
        const solutions = candidates.filter((file) => {
            if (graders.includes(file)) return false
            if (definitions.get(file)!.has('main')) {
                notes.push(`${file} 含 main，不作为解答`)
                return false
            }
            return (
                scans.get(file)!.includes.some((header) => headerNames.has(headerKey(header))) ||
                [...definitions.get(file)!].some((name) => declarations.has(name))
            )
        })
        return {
            confidence: 0.9,
            config: { grader: { sources: graders, includeDirs: ['.'] } },
            attachments: { grader: { sources: graders, headers } },
            excludeSources: graders,
            solutionFiles: solutions,
            notes
        }
    },
    build: solutionBuild,
    prepare: (ctx) => prepareShared(ctx),
    run: runShared,
    async describe(problem, src) {
        const units = solutionBuild({ problem, sourcePath: src, sourceDir: path.dirname(src), problemDir: '' })
        const files = await Promise.all(units.sources.map((file) => fileBadge('Grader', file)))
        if (!units.sources.length) files.push({ label: 'Grader', value: '未配置', tone: 'error' })
        const seen = new Set<string>()
        const addHeader = async (file: string) => {
            const key = process.platform === 'win32' ? file.toLowerCase() : file
            if (!seen.has(key)) {
                seen.add(key)
                files.push(await fileBadge('头文件', file))
            }
        }
        for (const directory of units.includeDirs) {
            const headers = await fs.readdir(directory).catch(() => undefined)
            if (!headers)
                files.push({
                    label: '包含目录',
                    value: path.basename(directory),
                    file: directory,
                    tone: 'error',
                    detail: '目录不存在或无法读取'
                })
            for (const header of (headers ?? []).filter((file) => /\.(h|hh|hpp|hxx)$/i.test(file)).sort())
                await addHeader(path.join(directory, header))
        }
        // Keep expected local headers visible even after one has been deleted from the folder.
        for (const source of [src, ...units.sources]) {
            const code = await fs.readFile(source, 'utf8').catch(() => '')
            for (const header of scanCpp(code).quotedIncludes.filter((file) => /\.(h|hh|hpp|hxx)$/i.test(file))) {
                const candidates = [...new Set([path.dirname(source), ...units.includeDirs])].map((directory) =>
                    path.resolve(directory, header)
                )
                const existing = await Promise.all(
                    candidates.map((file) =>
                        fs.stat(file).then(
                            (info) => info.isFile(),
                            () => false
                        )
                    )
                )
                await addHeader(candidates[existing.indexOf(true)] ?? candidates[0])
            }
        }
        if (problem.checker.kind === 'custom') files.push(...(await toolBadges('检查器', problem.checker, src)))
        return describeBase('grader', '函数式评测', problem, src, files)
    }
}
