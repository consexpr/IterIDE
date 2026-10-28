import { stat } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'
import type { ImportPreview, ImportRequest } from '../../shared/importer'
import { importProblemBatch } from '../problem/store'
import { isSampleName, naturalCompare, pairFiles } from './pairing'
import { captureResources } from '../problem/resources'
import { commonParent, importResources, openSource } from './source'

export { pairFiles } from './pairing'

/** Folder entries and ZIP entries both use portable paths relative to source. */
export async function previewImport(path: string): Promise<ImportPreview> {
    const source = resolve(path)
    const files = await openSource(source)
    try {
        const result = pairFiles(files.paths)
        // A ZIP export often has one packaging directory. Retain entry paths for reads.
        if (
            files.archive &&
            files.paths.length &&
            files.paths.every((path) => path.includes('/') && path.split('/')[0] === files.paths[0].split('/')[0])
        ) {
            const prefix = `${files.paths[0].split('/')[0]}/`
            for (const pair of result.pairs) pair.name = pair.name.slice(prefix.length)
            result.pairs.sort(
                (a, b) => Number(isSampleName(b.name)) - Number(isSampleName(a.name)) || naturalCompare(a.name, b.name)
            )
            result.notes.push(`已去掉压缩包外层目录 ${prefix}`)
        }
        return { source, ...result, notes: [...files.notes, ...result.notes] }
    } finally {
        files.close()
    }
}

/** Only the dropped files participate, even when other tests share their folder. */
export async function previewFiles(paths: string[]): Promise<ImportPreview> {
    const absolute = [...new Set(paths.map((path) => resolve(path)))]
    const source = commonParent(absolute)
    for (const path of absolute) {
        if (!(await stat(path)).isFile()) throw new Error(`Loose-file import expects regular files: ${path}`)
    }
    return { source, ...pairFiles(absolute.map((path) => relative(source, path).replaceAll('\\', '/'))) }
}

export async function applyImport(req: ImportRequest, report?: (message: string) => void): Promise<{ added: number }> {
    // Loose files can have a very broad common parent. Read only the selected entries.
    const source = await openSource(req.preview.source, { listDirectory: false })
    try {
        const attachments = req.attachExtras
            ? (['checker', 'interactor'] as const).flatMap((role) => {
                  const extra = req.preview.extras.find((item) => item.role === role)
                  return extra ? [{ ...extra, role }] : []
              })
            : []
        // Resolve requested entries before a replacement can remove existing tests.
        for (const pair of req.preview.pairs) {
            await source.assertFile(pair.input)
            if (pair.answer !== undefined) await source.assertFile(pair.answer)
        }
        for (const extra of attachments) await source.assertFile(extra.path)
        return await importProblemBatch(
            req.sourcePath,
            {
                replace: req.replace,
                tests: req.preview.pairs.map((pair) => ({
                    name: pair.name,
                    sample: isSampleName(pair.name),
                    input: (target) => source.copyEntry(pair.input, target),
                    ...(pair.answer === undefined
                        ? {}
                        : { answer: (target: string) => source.copyEntry(pair.answer!, target) })
                })),
                attachments: attachments.map((extra) => ({
                    role: extra.role,
                    extension: extname(extra.path).toLowerCase() === '.exe' ? '.exe' : '.cpp',
                    write: (target) => source.copyEntry(extra.path, target),
                    capture: async (directory) => {
                        const original = resolve(req.preview.source, extra.path)
                        const bundle = await captureResources(
                            directory,
                            [original],
                            [],
                            importResources(source, req.preview.source)
                        )
                        return bundle.file(original).replaceAll('\\', '/')
                    }
                }))
            },
            report
        )
    } finally {
        source.close()
    }
}
