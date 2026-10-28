import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { crc32 } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadProblem, problemDir, readTests, updateTestMeta, writeTest } from '../problem/store'
import { applyImport, previewFiles, previewImport } from './index'
import { writeZip } from './fixtures/zip'
import { commonParent, importLimits } from './source'

let temporary: string, sourcePath: string
async function files(contents: Record<string, string>, directory = temporary): Promise<string> {
    for (const [name, content] of Object.entries(contents)) {
        const target = join(directory, name)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, content)
    }
    return directory
}
const cases = () => readTests(sourcePath, 1000)
beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'iter-importer-'))
    vi.stubEnv('ITER_STORE', join(temporary, '.store'))
    sourcePath = join(temporary, 'demo.cpp')
    await writeFile(sourcePath, 'int main() {}')
})
afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(temporary, { recursive: true, force: true, maxRetries: 5 })
})

describe('preview adapters', () => {
    it('walks nested folders without creating problem metadata', async () => {
        await files({
            'subtask1/03.in': '1\n',
            'subtask1/03.ans': '2\n',
            'subtask2/03.in': '3\n',
            'subtask2/03.out': '4\n',
            '__MACOSX/._1.in': 'metadata',
            '.DS_Store': 'metadata',
            '.secret/4.in': 'hidden'
        })
        const before = await readdir(temporary, { recursive: true })
        const preview = await previewImport(temporary)
        expect(preview.source).toBe(resolve(temporary))
        expect(preview.pairs).toEqual([
            { name: 'subtask1/03', input: 'subtask1/03.in', answer: 'subtask1/03.ans' },
            { name: 'subtask2/03', input: 'subtask2/03.in', answer: 'subtask2/03.out' }
        ])
        expect(await readdir(temporary, { recursive: true })).toEqual(before)
    })

    it('lists a ZIP wrapper, backslashes, metadata and subtasks', async () => {
        const zip = join(temporary, 'data.ZIP')
        await writeZip(zip, [
            { name: 'package/' },
            { name: 'package\\subtask2\\03.in', content: '3' },
            { name: 'package/subtask2/03.out', content: '4' },
            { name: 'package/subtask1/03.in', content: '1' },
            { name: 'package/subtask1/03.ans', content: '2' },
            { name: '__MACOSX/._data.in' },
            { name: 'package/.DS_Store' }
        ])
        const preview = await previewImport(zip)
        expect(preview.pairs).toEqual([
            { name: 'subtask1/03', input: 'package/subtask1/03.in', answer: 'package/subtask1/03.ans' },
            { name: 'subtask2/03', input: 'package/subtask2/03.in', answer: 'package/subtask2/03.out' }
        ])
        expect(preview.notes).toContain('已去掉压缩包外层目录 package/')
    })

    it('decodes UTF-8, GBK and unflagged UTF-8 names, preserving input bytes', async () => {
        const legacy = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
            zip = join(temporary, 'names.zip')
        await writeZip(zip, [
            { name: '样例1.in', content: 'utf8' },
            { name: '样例1.ans', content: '答案' },
            { name: Buffer.concat([legacy, Buffer.from('2.in')]), flags: 0, content: 'gbk' },
            { name: Buffer.concat([legacy, Buffer.from('2.ans')]), flags: 0, content: 'gbk answer' },
            { name: '测试3.in', flags: 0 },
            { name: '测试3.ans', flags: 0 }
        ])
        const preview = await previewImport(zip)
        expect(preview.pairs.map((pair) => pair.name)).toEqual(expect.arrayContaining(['样例1', '中文2', '测试3']))
        expect(preview.notes).toContain('旧编码文件名已按 GB18030/CP437 尝试解码')
        await applyImport({ sourcePath, preview, replace: false, attachExtras: false })
        expect(await cases()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: '中文2', input: 'gbk', answer: 'gbk answer' }),
                expect.objectContaining({ name: '样例1', input: 'utf8', answer: '答案' })
            ])
        )
    })

    it('honors Info-ZIP Unicode path extra fields', async () => {
        const raw = Buffer.from('legacy.in'),
            unicode = Buffer.from('测试.in')
        const extra = Buffer.alloc(9 + unicode.length)
        extra.writeUInt16LE(0x7075)
        extra.writeUInt16LE(5 + unicode.length, 2)
        extra[4] = 1
        extra.writeUInt32LE(crc32(raw), 5)
        unicode.copy(extra, 9)
        const zip = join(temporary, 'unicode.zip')
        await writeZip(zip, [{ name: raw, flags: 0, extra, content: '7' }])
        expect((await previewImport(zip)).pairs).toEqual([{ name: '测试', input: '测试.in' }])
    })

    it('skips unsafe paths, links, encrypted entries and duplicates', async () => {
        const zip = join(temporary, 'unsafe.zip')
        await writeZip(zip, [
            { name: '../escape.in' },
            { name: 'C:\\absolute.in' },
            { name: '/absolute.in' },
            { name: 'link.in', mode: 0o120777, content: '../outside' },
            { name: 'encrypted.in', flags: 1 },
            { name: 'unknown.in', method: 99 },
            { name: '1.in', content: 'first' },
            { name: '1.in', content: 'second' },
            { name: '1.ans', content: 'answer' }
        ])
        const preview = await previewImport(zip)
        expect(preview.pairs).toEqual([{ name: '1', input: '1.in', answer: '1.ans' }])
        expect(preview.notes).toEqual(
            expect.arrayContaining([
                '已忽略压缩包不安全路径 ../escape.in',
                '已跳过符号链接 link.in',
                '已跳过加密文件 encrypted.in',
                '已跳过不支持的压缩格式 unknown.in',
                '1.in 重复，已采用首个文件'
            ])
        )
        await applyImport({ sourcePath, preview, replace: false, attachExtras: false })
        expect((await cases())[0]).toMatchObject({ input: 'first', answer: 'answer' })
    })

    it('lists corrupt data without inflation, then rejects it when applying', async () => {
        const zip = join(temporary, 'corrupt.zip')
        await writeZip(zip, [{ name: '1.in', content: 'original', corrupt: true }])
        const preview = await previewImport(zip)
        expect(preview.pairs).toHaveLength(1)
        await expect(applyImport({ sourcePath, preview, replace: false, attachExtras: false })).rejects.toThrow()
        expect((await loadProblem(sourcePath)).tests).toEqual([])
        await rm(zip)
    })

    it('rejects unsupported archives, invalid ZIPs and missing paths', async () => {
        await files({ 'data.7z': 'unsupported', 'broken.zip': 'not a zip' })
        await expect(previewImport(join(temporary, 'data.7z'))).rejects.toThrow(/not supported/)
        await expect(previewImport(join(temporary, 'broken.zip'))).rejects.toThrow()
        await expect(previewImport(join(temporary, 'missing'))).rejects.toThrow(/ENOENT/)
    })

    it('previews only selected loose files and finds their common parent', async () => {
        await files({ 'a/1.in': '1', 'a/1.ans': '2', 'a/extra.in': 'excluded', 'b/1.in': '3', 'b/1.out': '4' })
        const preview = await previewFiles(
            ['a/1.in', 'a/1.ans', 'b/1.in', 'b/1.out', 'a/1.in'].map((name) => join(temporary, name))
        )
        expect(preview.source).toBe(temporary)
        expect(preview.pairs.map((pair) => pair.name)).toEqual(['a/1', 'b/1'])
        await applyImport({ sourcePath, preview, replace: false, attachExtras: false })
        expect((await cases()).map((test) => test.input)).toEqual(['1', '3'])
        await expect(previewFiles([])).rejects.toThrow(/at least one/)
        await expect(previewFiles([temporary])).rejects.toThrow(/regular files/)
        if (process.platform === 'win32')
            expect(() => commonParent(['C:\\data\\1.in', 'D:\\data\\2.in'])).toThrow(/same filesystem root/)
    })

    it('never follows junctions outside a dataset, including forged selections', async () => {
        const dataset = await files({ '1.in': '1' }, join(temporary, 'dataset'))
        const external = await files({ '2.in': '2' }, join(temporary, 'external'))
        await symlink(external, join(dataset, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
        const preview = await previewImport(dataset)
        expect(preview.pairs.map((pair) => pair.name)).toEqual(['1'])
        expect(preview.notes).toContain('已跳过符号链接 link')
        const id = await writeTest(sourcePath, { input: 'old', answer: '' })
        preview.pairs.push({ name: 'external', input: 'link/2.in' })
        await expect(applyImport({ sourcePath, preview, replace: true, attachExtras: false })).rejects.toThrow(
            /inside the source/
        )
        expect((await loadProblem(sourcePath)).tests.map((test) => test.id)).toEqual([id])
    })
})

describe('applyImport with the real store', () => {
    it('appends samples while preserving old test metadata', async () => {
        const id = await writeTest(sourcePath, { name: 'old', input: 'old', answer: '' })
        await updateTestMeta(sourcePath, id, { enabled: false })
        await files({ 'sample1.in': '1\r\n2\n', 'sample1.ans': '3\n', '2.in': '4\n', 'checker.cpp': 'checker' })
        expect(
            await applyImport({
                sourcePath,
                preview: await previewImport(temporary),
                replace: false,
                attachExtras: false
            })
        ).toEqual({ added: 2 })
        expect((await cases()).map((test) => [test.name, test.input, test.enabled, test.sample])).toEqual([
            ['old', 'old', false, undefined],
            ['sample1', '1\r\n2\n', true, true],
            ['2', '4\n', true, undefined]
        ])
        expect((await loadProblem(sourcePath)).checker.kind).toBe('builtin')
    })

    it('replaces old tests without reconciling their retired files back in', async () => {
        await writeTest(sourcePath, { input: 'old', answer: 'old answer' })
        await files({ '1.in': 'new input', '1.ans': 'new answer' })
        await applyImport({ sourcePath, preview: await previewImport(temporary), replace: true, attachExtras: false })
        expect((await cases()).map((test) => [test.input, test.answer])).toEqual([['new input', 'new answer']])
        expect((await loadProblem(sourcePath)).tests).toHaveLength(1)
        expect((await readdir(problemDir(sourcePath))).some((name) => name.startsWith('.import-'))).toBe(false)
    })

    it.each(['checker.cpp', 'checker.exe'])('attaches %s and configures SPJ', async (checker) => {
        await files({ '1.in': '1', [checker]: 'checker bytes', 'testlib.h': 'header', 'val.cpp': 'validator' })
        await applyImport({ sourcePath, preview: await previewImport(temporary), replace: false, attachExtras: true })
        const config = await loadProblem(sourcePath)
        expect(config.mode).toBe('spj')
        expect(config.checker.kind).toBe('custom')
        expect(await readFile(join(problemDir(sourcePath), config.checker.path!), 'utf8')).toBe('checker bytes')
    })

    it('streams ZIP attachments and preserves interactive precedence', async () => {
        const zip = join(temporary, 'extras.zip')
        await writeZip(zip, [
            { name: 'data/1.in', content: '1' },
            { name: 'data/1.ans', content: '2' },
            { name: 'tools/checker.cpp', content: 'checker' },
            { name: 'tools/interactor.cpp', content: 'interactor' }
        ])
        await applyImport({ sourcePath, preview: await previewImport(zip), replace: false, attachExtras: true })
        const config = await loadProblem(sourcePath)
        expect(config.mode).toBe('interactive')
        expect(await readFile(join(problemDir(sourcePath), config.checker.path!), 'utf8')).toBe('checker')
        expect(await readFile(join(problemDir(sourcePath), config.interactor!.path), 'utf8')).toBe('interactor')
        expect((await readdir(problemDir(sourcePath))).some((name) => name.startsWith('.import-'))).toBe(false)
        await rm(zip)
    })

    it('supports extras-only imports', async () => {
        await files({ 'interact.cpp': 'interactive' })
        expect(
            await applyImport({
                sourcePath,
                preview: await previewImport(temporary),
                replace: false,
                attachExtras: true
            })
        ).toEqual({ added: 0 })
        expect((await loadProblem(sourcePath)).mode).toBe('interactive')
        expect(await cases()).toEqual([])
    })

    it('validates missing and traversing selections before replacing tests', async () => {
        await writeTest(sourcePath, { input: 'original', answer: '' })
        await files({ '1.in': '1', '1.ans': '2' })
        const preview = await previewImport(temporary)
        await rm(join(temporary, '1.ans'))
        await expect(applyImport({ sourcePath, preview, replace: true, attachExtras: false })).rejects.toThrow(/ENOENT/)
        preview.pairs = [{ name: 'bad', input: '../outside.in' }]
        await expect(applyImport({ sourcePath, preview, replace: true, attachExtras: false })).rejects.toThrow(
            /Invalid import entry/
        )
        expect((await cases())[0].input).toBe('original')
    })

    it('rejects corrupt attachments before committing and removes all staging data', async () => {
        await writeTest(sourcePath, { input: 'original', answer: '' })
        const zip = join(temporary, 'extras.zip')
        await writeZip(zip, [
            { name: '1.in', content: 'new' },
            { name: 'checker.cpp', content: 'bad', corrupt: true }
        ])
        await expect(
            applyImport({ sourcePath, preview: await previewImport(zip), replace: true, attachExtras: true })
        ).rejects.toThrow()
        expect((await cases())[0].input).toBe('original')
        expect((await readdir(problemDir(sourcePath))).some((name) => name.startsWith('.import-'))).toBe(false)
        await rm(zip)
    })

    it('copies non-UTF-8 input and answers byte-for-byte', async () => {
        const zip = join(temporary, 'binary.zip'),
            data = Buffer.from([0xff, 0xfe, 0x00, 0x0d, 0x0a])
        await writeZip(zip, [
            { name: '1.in', content: data },
            { name: '1.ans', content: data }
        ])
        await applyImport({ sourcePath, preview: await previewImport(zip), replace: false, attachExtras: false })
        const config = await loadProblem(sourcePath)
        expect(await readFile(join(problemDir(sourcePath), 'tests', config.tests[0].id + '.in'))).toEqual(data)
        expect(await readFile(join(problemDir(sourcePath), 'tests', config.tests[0].id + '.ans'))).toEqual(data)
    })

    it('enforces advertised ZIP budgets before extraction', async () => {
        const zip = join(temporary, 'limited.zip'),
            limit = importLimits.file
        await writeZip(zip, [{ name: '1.in', content: '123' }])
        try {
            importLimits.file = 2
            await expect(previewImport(zip)).rejects.toThrow(/大小上限/)
        } finally {
            importLimits.file = limit
        }
    })

    it.each(['folder', 'zip'])(
        'streams >64MiB input and answer without truncation from %s',
        async (kind) => {
            const size = 64 * 1024 * 1024 + 17
            let source = temporary
            if (kind === 'zip') {
                source = join(temporary, 'large.zip')
                await writeZip(source, [
                    { name: '1.in', content: Buffer.alloc(size, 0x31) },
                    { name: '1.ans', content: Buffer.alloc(size, 0x32) }
                ])
            } else {
                await writeFile(join(temporary, '1.in'), Buffer.alloc(size, 0x31))
                await writeFile(join(temporary, '1.ans'), Buffer.alloc(size, 0x32))
            }
            await applyImport({ sourcePath, preview: await previewImport(source), replace: false, attachExtras: false })
            const config = await loadProblem(sourcePath)
            for (const [extension, value] of [
                ['in', 0x31],
                ['ans', 0x32]
            ] as const) {
                const file = join(problemDir(sourcePath), 'tests', config.tests[0].id + '.' + extension)
                expect((await stat(file)).size).toBe(size)
                const handle = await open(file, 'r'),
                    suffix = Buffer.alloc(17)
                try {
                    await handle.read(suffix, 0, 17, size - 17)
                } finally {
                    await handle.close()
                }
                expect(suffix).toEqual(Buffer.alloc(17, value))
            }
        },
        30_000
    )
})
