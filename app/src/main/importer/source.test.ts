import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { previewFolder } from './folder'
import { importLimits, openSource } from './source'

let directory: string
const entryLimit = importLimits.entries

beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-import-source-'))
})

afterEach(async () => {
    importLimits.entries = entryLimit
    if (
        path.dirname(directory) !== path.resolve(os.tmpdir()) ||
        !path.basename(directory).startsWith('iter-import-source-')
    )
        throw new Error('Invalid fixture cleanup path')
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5 })
})

describe('local import resource budgets', () => {
    it('reads ordinary source text without changing Unicode or line endings', async () => {
        const text = '// 样例\r\nint main() {}\n'
        await fs.writeFile(path.join(directory, 'solution.cpp'), text)
        const source = await openSource(directory)
        try {
            expect(await source.readText('solution.cpp')).toBe(text)
        } finally {
            source.close()
        }
    })

    it('rejects oversized local source text during both resource capture and folder detection', async () => {
        const file = path.join(directory, 'solution.cpp')
        await fs.writeFile(file, '')
        await fs.truncate(file, 16 * 1024 * 1024 + 1)
        const source = await openSource(directory)
        try {
            await expect(source.readText('solution.cpp')).rejects.toThrow(/16 MiB/)
            await expect(previewFolder(directory)).rejects.toThrow(/16 MiB/)
        } finally {
            source.close()
        }
    })

    it('enforces one entry budget across nested directories and releases directory handles', async () => {
        await fs.mkdir(path.join(directory, 'nested'))
        await fs.writeFile(path.join(directory, 'nested', '1.in'), '1')
        await fs.writeFile(path.join(directory, 'nested', '2.in'), '2')
        importLimits.entries = 2
        await expect(openSource(directory)).rejects.toThrow(/目录文件数量超过导入上限/)
        // The failed iterator must close its directory handle, including on Windows.
        await fs.rename(path.join(directory, 'nested'), path.join(directory, 'renamed'))
        const source = await openSource(directory, { listDirectory: false })
        try {
            expect(await source.readText('renamed/1.in')).toBe('1')
        } finally {
            source.close()
        }
    })
})
