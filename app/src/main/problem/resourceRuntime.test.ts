import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resourceContext, resourceStrings, rewriteRuntimeStrings } from './resourceRuntime'

it('recognizes path strings and macro values while skipping comments, character literals and includes', () => {
    const code =
        '// "ignored.txt"\n/* "also ignored" */\n#include "header.h"\n#define FILE "data.txt"\nconst char* path=R"tag(subdir/raw.txt)tag";\nchar quote=\'"\';'
    expect(resourceStrings(code)).toEqual(['data.txt', 'subdir/raw.txt'])
    expect(rewriteRuntimeStrings(code, { 'data.txt': 'CACHED_DATA' })).toContain('#define FILE CACHED_DATA')
    expect(rewriteRuntimeStrings(code, { 'ignored.txt': 'BAD' })).toContain('// "ignored.txt"')
})
it('rewrites escaped Windows paths without modifying unrelated strings', () => {
    const code = 'auto file="C:\\\\data\\\\weights.txt"; auto label="weight";'
    expect(resourceStrings(code)).toEqual(['C:\\data\\weights.txt', 'weight'])
    expect(rewriteRuntimeStrings(code, { 'C:\\data\\weights.txt': 'MANAGED_FILE' })).toBe(
        'auto file=MANAGED_FILE; auto label="weight";'
    )
})

it.each(['ITER', 'NAVEN'])('loads cached %s resource macros without rewriting source files', async (brand) => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'iter-resource-brand-'))
    const root = path.join(temporary, 'resources', 'a0000000-0000-0000-0000-000000000001')
    const macro = `${brand}_RESOURCE_0123456789abcdef`
    try {
        await mkdir(root, { recursive: true })
        await writeFile(
            path.join(root, 'bundle.json'),
            JSON.stringify({
                version: 1,
                digest: 'fixture',
                includeDirs: [],
                assets: { [macro]: 'weights.txt' }
            })
        )
        const context = await resourceContext([path.join(root, 'checker.cpp')])
        expect(context.flags).toEqual([
            `-D${macro}=${JSON.stringify(path.join(root, 'weights.txt').replaceAll('\\', '/'))}`
        ])
    } finally {
        await rm(temporary, { recursive: true, force: true })
    }
})
