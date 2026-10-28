import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../../shared/settings'
import { effectiveFormatStyle } from '../format/style'
import { FormattingDocuments } from './formatting'

vi.mock('../format/style', () => ({ effectiveFormatStyle: vi.fn() }))
vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof fs>()
    return { ...actual, writeFile: vi.fn(actual.writeFile) }
})

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => {
        resolve = done
    })
    return { promise, resolve }
}

describe('formatting document disposal during preparation', () => {
    let actual: typeof fs, root: string, documents: FormattingDocuments
    let pending: Promise<unknown> | undefined, unblock: (() => void) | undefined
    const systemTemp = path.resolve(os.tmpdir())

    beforeEach(async () => {
        actual = await vi.importActual<typeof fs>('node:fs/promises')
        root = await actual.mkdtemp(path.join(systemTemp, 'iter-format-lifecycle-'))
        vi.spyOn(os, 'tmpdir').mockReturnValue(root)
        vi.mocked(fs.writeFile).mockImplementation(actual.writeFile)
        vi.mocked(effectiveFormatStyle).mockResolvedValue('BasedOnStyle: LLVM\n')
        documents = new FormattingDocuments()
        pending = undefined
        unblock = undefined
    })

    afterEach(async () => {
        unblock?.()
        await pending?.catch(() => {})
        await documents.dispose()
        vi.restoreAllMocks()
        // Remove only the independent temporary directory this test created.
        if (path.dirname(root) !== systemTemp || !path.basename(root).startsWith('iter-format-lifecycle-'))
            throw new Error('Unexpected formatting test directory')
        await actual.rm(root, { recursive: true, force: true })
    })

    function prepare(): Promise<unknown> {
        pending = documents.prepare(1, pathToFileURL(path.join(root, 'source.cpp')).href, defaultSettings())
        void pending.catch(() => {})
        return pending
    }

    it('rejects a configuration result arriving after disposal without creating files', async () => {
        const style = deferred<string>()
        unblock = () => style.resolve('BasedOnStyle: LLVM\n')
        vi.mocked(effectiveFormatStyle).mockReturnValue(style.promise)
        const preparing = prepare()
        await documents.dispose()
        unblock()
        await expect(preparing).rejects.toMatchObject({ name: 'AbortError' })
        expect(await actual.readdir(root)).toEqual([])
        expect(documents.finish(1)).toBeUndefined()
    })

    it('removes a configuration written after disposal instead of registering a leaked document', async () => {
        const written = deferred<void>(),
            resume = deferred<void>()
        unblock = () => resume.resolve()
        vi.mocked(fs.writeFile).mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
            await actual.writeFile(...args)
            written.resolve()
            await resume.promise
        })
        const preparing = prepare()
        await written.promise
        expect(await actual.readdir(root)).toHaveLength(1)
        await documents.dispose()
        unblock()
        await expect(preparing).rejects.toMatchObject({ name: 'AbortError' })
        expect(await actual.readdir(root)).toEqual([])
        expect(documents.finish(1)).toBeUndefined()
    })
})
