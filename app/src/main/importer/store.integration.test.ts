import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadProblem, problemDir, writeTest } from '../problem/store'
import { applyImport, previewFiles, previewImport } from './index'
import { writeZip } from './fixtures/zip'

let temporary: string
let sourcePath: string
beforeEach(async () => {
    temporary = await mkdtemp(join(import.meta.dirname, '.integration-'))
    vi.stubEnv('ITER_STORE', join(temporary, '.store'))
    sourcePath = join(temporary, 'main.cpp')
    await writeFile(sourcePath, 'int main() {}\n')
})
afterEach(async () => {
    vi.unstubAllEnvs()
    if (!temporary.startsWith(join(import.meta.dirname, '.integration-'))) throw new Error('Invalid cleanup path')
    await rm(temporary, { recursive: true, force: true })
})

describe('importer with the real problem store', () => {
    it('appends selected loose files, then replaces tests from a folder and persists checker configuration', async () => {
        const data = join(temporary, 'data')
        await mkdir(data)
        await writeFile(join(data, 'sample1.in'), '1\r\n2\n')
        await writeFile(join(data, 'sample1.ans'), '3\n')
        await writeFile(join(data, 'unselected.in'), 'not selected')
        await writeTest(sourcePath, { name: 'old', input: 'old input', answer: 'old answer' })
        const loose = await previewFiles([join(data, 'sample1.in'), join(data, 'sample1.ans')])
        expect(await applyImport({ sourcePath, preview: loose, replace: false, attachExtras: false })).toEqual({
            added: 1
        })
        const appended = await loadProblem(sourcePath)
        expect(appended.tests.map((test) => test.name)).toEqual(['old', 'sample1'])
        expect(appended.tests[1].sample).toBe(true)
        expect(await readFile(join(problemDir(sourcePath), 'tests', `${appended.tests[1].id}.in`), 'utf8')).toBe(
            '1\r\n2\n'
        )

        const replacement = join(temporary, 'replacement')
        await mkdir(replacement)
        await writeFile(join(replacement, '01.in'), 'new input')
        await writeFile(join(replacement, 'checker.cpp'), '// custom checker\n')
        await applyImport({ sourcePath, preview: await previewImport(replacement), replace: true, attachExtras: true })
        const replaced = await loadProblem(sourcePath)
        expect(replaced.tests.map((test) => test.name)).toEqual(['01'])
        expect(replaced.mode).toBe('spj')
        expect(replaced.checker.kind).toBe('custom')
        expect(await readFile(join(problemDir(sourcePath), replaced.checker.path!), 'utf8')).toBe('// custom checker\n')
        expect(await readFile(join(problemDir(sourcePath), 'tests', `${replaced.tests[0].id}.in`), 'utf8')).toBe(
            'new input'
        )
        expect(await readFile(join(problemDir(sourcePath), 'tests', `${replaced.tests[0].id}.ans`), 'utf8')).toBe('')
    })

    it('persists ZIP test content and binary executables byte-for-byte', async () => {
        const zip = join(temporary, 'data.zip')
        const executable = Buffer.from([0x4d, 0x5a, 0, 0xff, 0xfe, 0x80, 0x0d, 0x0a])
        await writeZip(zip, [
            { name: 'package/tests/01', content: 'input\n' },
            { name: 'package/tests/01.a', content: 'answer\n' },
            { name: 'package/checker.exe', content: executable },
            { name: 'package/interactor.cpp', content: '// interactor\n' }
        ])
        await applyImport({ sourcePath, preview: await previewImport(zip), replace: false, attachExtras: true })
        const config = await loadProblem(sourcePath)
        expect(config.tests.map((test) => test.name)).toEqual(['tests/01'])
        expect(config.mode).toBe('interactive')
        expect(config.checker.kind).toBe('custom')
        expect(await readFile(join(problemDir(sourcePath), config.checker.path!))).toEqual(executable)
        expect(await readFile(join(problemDir(sourcePath), config.interactor!.path), 'utf8')).toBe('// interactor\n')
        expect(await readFile(join(problemDir(sourcePath), 'tests', `${config.tests[0].id}.in`), 'utf8')).toBe(
            'input\n'
        )
        expect(await readFile(join(problemDir(sourcePath), 'tests', `${config.tests[0].id}.ans`), 'utf8')).toBe(
            'answer\n'
        )
    })
})
