import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { attachCode, loadProblem, patchProblem, problemDir, readChecker } from './store'
import { applyImport, previewImport } from '../importer'
import { writeZip } from '../importer/fixtures/zip'
import { checkerSettingsPatch } from '../../shared/checkerSelection'

let root: string, source: string
beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-checker-edit-'))
    vi.stubEnv('ITER_STORE', path.join(root, 'store'))
    source = path.join(root, 'solution.cpp')
    await fs.writeFile(source, 'int main(){}')
})
afterEach(async () => {
    vi.unstubAllEnvs()
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('iter-checker-edit-'))
        throw Error('Invalid cleanup path')
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 })
})

it.each(['folder', 'zip'])(
    'edits a %s checker in the common code editor without losing its headers or arguments',
    async (kind) => {
        const entries = [
            { name: 'checker.cpp', content: '// n-check 1\n#include "value.h"\nint main(){return VALUE;}' },
            { name: 'value.h', content: '#define VALUE 0\n' },
            { name: '1.in', content: '1' },
            { name: '1.ans', content: '1' }
        ]
        const input = path.join(root, kind === 'zip' ? 'problem.zip' : 'problem')
        if (kind === 'zip') await writeZip(input, entries)
        else {
            await fs.mkdir(input)
            await Promise.all(entries.map((entry) => fs.writeFile(path.join(input, entry.name), entry.content)))
        }
        const preview = await previewImport(input)
        expect(preview.extras.some((extra) => extra.role === 'checker')).toBe(true)
        await applyImport({ sourcePath: source, preview, replace: false, attachExtras: true })
        const config = await loadProblem(source)
        const before = await readChecker(source)
        expect(before).toContain('return VALUE')
        const oldFile = path.join(problemDir(source), config.checker.path!)
        const edited = before! + '\n// edited in the shared window\n'
        const next = await attachCode(source, edited)
        await patchProblem(
            source,
            checkerSettingsPatch(config, { kind: 'custom', path: next, args: '{answer} {output}' })
        )
        expect((await loadProblem(source)).checker.args).toBe('{answer} {output}')
        expect(await fs.readFile(oldFile, 'utf8')).toBe(before)
        const code = (await readChecker(source))!
        expect(code).toContain('edited in the shared window')
        const header = code.match(/#include "([^"]+)"/)![1]
        expect(
            await fs.readFile(path.resolve(path.dirname(path.join(problemDir(source), next)), header), 'utf8')
        ).toContain('VALUE 0')
        if (kind === 'folder')
            expect(await fs.readFile(path.join(input, 'checker.cpp'), 'utf8')).toBe(entries[0].content)
    }
)
