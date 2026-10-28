import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { userAssetPath } from './userAssets'

let temp: string, root: string
beforeEach(async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), 'iter-assets-'))
    root = path.join(temp, 'themes')
    await mkdir(path.join(root, '中文'), { recursive: true })
    await writeFile(path.join(root, '中文', 'theme.css'), 'body{}')
    await writeFile(path.join(root, '中文.woff2'), 'font')
})
afterEach(async () => {
    await rm(temp, { recursive: true, force: true })
})

it('preserves encoded Unicode theme and font URLs', async () => {
    expect(await userAssetPath(root, '/%E4%B8%AD%E6%96%87/theme.css')).toBe(path.join(root, '中文', 'theme.css'))
    expect(await userAssetPath(root, '/%E4%B8%AD%E6%96%87.woff2', true)).toBe(path.join(root, '中文.woff2'))
})
it('rejects traversal, malformed encodings, Windows aliases and non-font files', async () => {
    for (const name of [
        '/../outside',
        '/%2e%2e/outside',
        '/中文/..%5coutside',
        '/%00',
        '/%zz',
        '//中文/theme.css',
        '/C:/test',
        '/中文/theme.css:stream',
        '/中文/theme.css.'
    ]) {
        expect(await userAssetPath(root, name)).toBeNull()
    }
    expect(await userAssetPath(root, '/中文/theme.css', true)).toBeNull()
    expect(await userAssetPath(root, '/中文')).toBeNull()
})
it('rejects a directory junction escaping the asset root', async () => {
    const outside = path.join(temp, 'outside')
    await mkdir(outside)
    await writeFile(path.join(outside, 'private.css'), 'private')
    await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await userAssetPath(root, '/linked/private.css')).toBeNull()
})
