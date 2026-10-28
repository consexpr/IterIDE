import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import type { FolderImportPreview, ProblemFolderImportRequest, ProblemFolderPreview } from '../../shared/importer'
import type { ProblemConfig } from '../../shared/problem'
import { existingProblemDir, importProblemBatch } from '../problem/store'
import { captureResources } from '../problem/resources'
import { ignoredEntry, isSampleName, naturalCompare, pairFiles } from './pairing'
import { openSource, readImportText } from './source'
import { functionNames, modeFolder, rankSources, scanCpp } from './source-analysis'
import { detectModes } from '../judge/modes/registry'

const isTemplate = (file: string): boolean => /^(?:template_.*|.*_template.*)\.cpp$/i.test(file)
const isHeader = (file: string): boolean => /\.(?:h|hh|hpp|hxx)$/i.test(file)
const pathKey = (file: string): string => (process.platform === 'win32' ? resolve(file).toLowerCase() : resolve(file))
/** Retained alias for callers; detection metadata is part of the shared preview contract. */
export type ModeFolderPreview = ProblemFolderPreview

/** Pure inference over direct entries only: a contest's children are analysed independently. */
export function analyzeProblemFiles(
    dir: string,
    entries: string[],
    code: Record<string, string> = {},
    modified: Record<string, number> = {}
): ModeFolderPreview | null {
    const files = entries
        .filter((file) => !/[\\/]/.test(file) && !ignoredEntry(file) && !/\.pdf$/i.test(file))
        .sort(naturalCompare)
    const paired = pairFiles(files)
    if (!paired.pairs.length && !paired.unmatched.length) return null
    const cpp = files.filter((file) => /\.cpp$/i.test(file))
    const templates = cpp.filter(isTemplate)
    const template = templates[0]
    const detected = detectModes(modeFolder(resolve(dir), files, code))
    const winner = detected[0]
    const attachments = Object.assign(
        {},
        ...[...detected].reverse().map((match) => match.detection.attachments)
    ) as Pick<ProblemFolderPreview, 'checker' | 'interactor' | 'grader'>
    const modeConfig: Record<string, unknown> = Object.assign(
        {},
        ...[...detected].reverse().map((match) => match.detection.config),
        winner ? { mode: winner.mode.id } : {}
    )
    const scans = new Map(cpp.map((file) => [file, scanCpp(code[file] ?? '')]))
    const definitions = new Map(cpp.map((file) => [file, functionNames(scans.get(file)!.body, 'definition')]))
    const tools = new Set([
        ...paired.extras.filter((extra) => extra.role !== 'solution').map((extra) => extra.path),
        ...detected.flatMap((match) => match.detection.excludeSources ?? [])
    ])
    const candidates = cpp.filter((file) => !isTemplate(file) && !tools.has(file))
    const absolute = (file: string): string => resolve(dir, file)
    const notes = [...paired.notes, ...detected.flatMap((match) => match.detection.notes ?? [])]
    if (paired.pairs.length) notes.push(`发现 ${paired.pairs.length} 组测试数据`)
    if (template) notes.push(`可用模板：${template}`)
    if (templates.length > 1) notes.push(`有多个模板，默认采用 ${template}`)
    const { checker, interactor, grader } = attachments
    const solutionFiles = detected.find((match) => match.detection.solutionFiles !== undefined)?.detection.solutionFiles
    const sources = rankSources(
        candidates.filter((file) => {
            return solutionFiles ? solutionFiles.includes(file) : definitions.get(file)!.has('main')
        }),
        basename(resolve(dir)),
        modified
    ).map(absolute)
    if (!sources.length) notes.push('未发现用户代码，可新建解答')
    return {
        dir: resolve(dir),
        name: basename(resolve(dir)),
        sources,
        notes,
        mode: winner?.mode.id,
        modeConfig,
        pairs: paired.pairs.map((pair) => ({
            ...pair,
            input: absolute(pair.input),
            ...(pair.answer === undefined ? {} : { answer: absolute(pair.answer) })
        })),
        unmatched: paired.unmatched.map(absolute),
        ...(template ? { template: absolute(template) } : {}),
        ...(checker ? { checker: absolute(checker) } : {}),
        ...(interactor ? { interactor: absolute(interactor) } : {}),
        ...(grader ? { grader: { sources: grader.sources.map(absolute), headers: grader.headers.map(absolute) } } : {})
    }
}

async function savedProblem(
    sourcePath: string
): Promise<{ tests?: { id?: string; link?: { input?: string } }[] } | undefined> {
    try {
        return JSON.parse(
            (await readFile(join(existingProblemDir(sourcePath), 'problem.json'), 'utf8')).replace(/^\uFEFF/, '')
        )
    } catch (error) {
        if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
    }
}

async function inspectProblem(dir: string): Promise<ProblemFolderPreview | null> {
    const entries = (await readdir(dir, { withFileTypes: true })).filter(
        (entry) => entry.isFile() && !ignoredEntry(entry.name)
    )
    const documents = await Promise.all(
        entries
            .filter((entry) => /\.cpp$/i.test(entry.name) || isHeader(entry.name))
            .map(async (entry) => {
                const file = join(dir, entry.name)
                const [code, info] = await Promise.all([readImportText(file), stat(file)])
                return { name: entry.name, code, modified: info.mtimeMs }
            })
    )
    const code = Object.fromEntries(documents.map((file) => [file.name, file.code]))
    const modified = Object.fromEntries(documents.map((file) => [file.name, file.modified]))
    const problem = analyzeProblemFiles(
        dir,
        entries.map((entry) => entry.name),
        code,
        modified
    )
    if (!problem) return null
    const inputs = new Set(problem.pairs.map((pair) => pathKey(pair.input)))
    for (const source of problem.sources) {
        const config = await savedProblem(source)
        if (
            Array.isArray(config?.tests) &&
            config.tests.some(
                (test) =>
                    typeof test?.link?.input === 'string' &&
                    inputs.has(pathKey(resolve(dirname(source), test.link.input)))
            )
        ) {
            problem.boundSource = source
            problem.sources = [source, ...problem.sources.filter((file) => file !== source)]
            problem.notes.push(`已绑定解答：${basename(source)}`)
            break
        }
    }
    return problem
}

export async function previewFolder(dir: string): Promise<FolderImportPreview> {
    const root = resolve(dir)
    const problem = await inspectProblem(root)
    if (problem) return { kind: 'problem', root, problems: [problem] }
    const children = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !ignoredEntry(entry.name))
        .sort((a, b) => naturalCompare(a.name, b.name))
    const problems: ProblemFolderPreview[] = []
    for (const child of children) {
        const item = await inspectProblem(join(root, child.name))
        if (item) problems.push(item)
    }
    return { kind: problems.length ? 'contest' : 'none', root, problems }
}

export async function detectForSource(sourcePath: string): Promise<ProblemFolderPreview | null> {
    const existing = await savedProblem(sourcePath)
    if (Array.isArray(existing?.tests) && existing.tests.length) return null
    const problem = await inspectProblem(dirname(resolve(sourcePath)))
    // Tools and templates are not user solutions to auto-bind.
    return problem?.sources.some((file) => pathKey(file) === pathKey(sourcePath)) ? problem : null
}

export async function applyFolder(
    req: ProblemFolderImportRequest,
    report?: (message: string) => void
): Promise<{ sourcePath: string; added: number }> {
    const sourcePath = resolve(req.sourcePath),
        base = dirname(sourcePath),
        root = resolve(req.problem.dir)
    const source = await openSource(root, { listDirectory: false })
    const capturedTools: Partial<Record<'checker' | 'interactor', string>> = {}
    const absolute = (file: string): string => resolve(root, file)
    const fromSource = (file: string): string => {
        const result = relative(base, absolute(file)).replaceAll('\\', '/') || '.'
        return result.includes(':') ? absolute(file) : result
    }
    try {
        const data = req.problem.pairs.flatMap((pair) => [
            pair.input,
            ...(pair.answer === undefined ? [] : [pair.answer])
        ])
        const tools = [
            req.problem.checker,
            req.problem.interactor,
            ...(req.problem.grader?.sources ?? []),
            ...(req.problem.grader?.headers ?? [])
        ].filter((file): file is string => file !== undefined)
        // Validate the entire selection before replacing any existing tests or creating code.
        for (const file of [...data, ...tools]) await source.assertFile(relative(root, absolute(file)))
        const existingSource = await stat(sourcePath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
            return undefined
        })
        if (existingSource && !existingSource.isFile())
            throw new Error(`Solution path is not a regular file: ${sourcePath}`)
        if (!existingSource) {
            if (req.initialCode === undefined)
                throw new Error(`Initial code is required to create the solution: ${sourcePath}`)
            await mkdir(base, { recursive: true })
            try {
                await writeFile(sourcePath, req.initialCode, { encoding: 'utf8', flag: 'wx' })
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
            }
        }
        const result = await importProblemBatch(
            sourcePath,
            {
                replace: req.replaceTests,
                // Explicit imports own both tools, even when the selected mode only uses one.
                attachments: (['checker', 'interactor'] as const).flatMap((role) => {
                    const file = req.problem[role]
                    return file
                        ? [
                              {
                                  role,
                                  extension: /\.exe$/i.test(file) ? '.exe' : '.cpp',
                                  write: (target: string) => source.copyEntry(relative(root, absolute(file)), target),
                                  capture: async (directory: string) => {
                                      const original = absolute(file)
                                      const bundle = await captureResources(directory, [original], [base])
                                      const captured = bundle.file(original).replaceAll('\\', '/')
                                      capturedTools[role] = captured
                                      return captured
                                  }
                              }
                          ]
                        : []
                }),
                tests: req.problem.pairs.map((pair) => ({
                    name: pair.name,
                    sample: isSampleName(pair.name),
                    ...(req.link
                        ? {
                              link: {
                                  input: absolute(pair.input),
                                  ...(pair.answer === undefined ? {} : { answer: absolute(pair.answer) })
                              }
                          }
                        : {
                              input: (target: string) => source.copyEntry(relative(root, absolute(pair.input)), target),
                              ...(pair.answer === undefined
                                  ? {}
                                  : {
                                        answer: (target: string) =>
                                            source.copyEntry(relative(root, absolute(pair.answer!)), target)
                                    })
                          })
                })),
                configure: (latest) => {
                    // The IPC-facing record carries the detector's partial ProblemConfig, not a nested field to save.
                    const modeConfig = req.problem.modeConfig as Partial<ProblemConfig> | undefined
                    const mode =
                        req.problem.mode ||
                        (typeof modeConfig?.mode === 'string' && modeConfig.mode.length > 0
                            ? modeConfig.mode
                            : undefined)
                    if (modeConfig) {
                        // A detection supplies settings, never replaces the cases just imported above.
                        const { tests: _tests, version: _version, title: _title, ...settings } = modeConfig
                        Object.assign(latest, settings)
                    }
                    if (mode) latest.mode = mode
                    latest.title = req.problem.name
                    latest.fileIO = {
                        enabled: false,
                        input: `${req.problem.name}.in`,
                        output: `${req.problem.name}.out`
                    }
                    if (modeConfig?.checker?.kind === 'custom' && modeConfig.checker.path)
                        latest.checker = {
                            ...latest.checker,
                            path: fromSource(modeConfig.checker.path),
                            relativeTo: 'source'
                        }
                    if (modeConfig?.interactor?.path)
                        latest.interactor = {
                            ...latest.interactor!,
                            path: fromSource(modeConfig.interactor.path),
                            relativeTo: 'source'
                        }
                    if (modeConfig?.grader)
                        latest.grader = {
                            sources: modeConfig.grader.sources.map(fromSource),
                            includeDirs: modeConfig.grader.includeDirs?.map(fromSource)
                        }
                    if (modeConfig?.fileIO) latest.fileIO = modeConfig.fileIO
                    if (req.problem.checker) {
                        latest.checker = {
                            ...latest.checker,
                            kind: 'custom',
                            path: capturedTools.checker!,
                            relativeTo: undefined
                        }
                        if (!mode) latest.mode = 'spj'
                    }
                    if (req.problem.interactor) {
                        latest.interactor = {
                            ...latest.interactor,
                            path: capturedTools.interactor!,
                            relativeTo: undefined
                        }
                        if (!mode) latest.mode = 'interactive'
                    }
                    if (req.problem.grader)
                        latest.grader = {
                            sources: req.problem.grader.sources.map(fromSource),
                            includeDirs: [
                                ...new Set([
                                    ...(modeConfig?.grader?.includeDirs ?? []).map(fromSource),
                                    ...[root, ...req.problem.grader.headers.map((file) => dirname(absolute(file)))].map(
                                        fromSource
                                    )
                                ])
                            ]
                        }
                }
            },
            report
        )
        return { sourcePath, added: result.added }
    } finally {
        source.close()
    }
}
