import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { loadSession, saveSession, sanitizeSession } from './session'

let root: string
beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-session-queue-'))
})
afterEach(async () => {
    vi.restoreAllMocks()
    if (
        path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) ||
        !path.basename(root).startsWith('iter-session-queue-')
    )
        throw new Error('Invalid cleanup path')
    await fs.rm(root, { recursive: true, force: true })
})

it('round-trips editor positions and folding state while dropping malformed view metadata', async () => {
    const viewState = {
        cursorState: [
            {
                inSelectionMode: false,
                selectionStart: { lineNumber: 9, column: 3 },
                position: { lineNumber: 9, column: 3 }
            }
        ],
        viewState: { scrollLeft: 10, firstPosition: { lineNumber: 5, column: 1 }, firstPositionDeltaTop: -2 },
        contributionsState: { 'editor.contrib.folding': { collapsedRegions: [{ start: 2, end: 8 }] } }
    }
    const data = snapshot('buffer')
    await saveSession(root, { ...data, tabs: [{ ...data.tabs[0], viewState }] })
    expect((await loadSession(root))?.tabs[0].viewState).toEqual(viewState)
    expect(
        sanitizeSession({
            tabs: [{ ...data.tabs[0], viewState: { ...viewState, cursorState: [{ position: { lineNumber: -1 } }] } }]
        })?.tabs[0].viewState
    ).toBeUndefined()
})

it('reports damaged sessions so startup cannot sweep managed buffers using an empty session', async () => {
    await fs.writeFile(path.join(root, 'session.json'), '{invalid')
    await expect(loadSession(root)).rejects.toThrow('会话文件无法读取')
    expect(await fs.readFile(path.join(root, 'session.json'), 'utf8')).toBe('{invalid')
    await fs.writeFile(path.join(root, 'session.json'), '{}')
    await expect(loadSession(root)).rejects.toThrow('会话文件无法读取')
})
const snapshot = (text: string) => ({
    version: 1 as const,
    active: '/source.cpp',
    tabs: [{ path: '/source.cpp', text, saved: '' }]
})

it('makes a final save wait for an older pending publication and leaves the newest snapshot on disk', async () => {
    const rename = fs.rename.bind(fs)
    let release!: () => void, entered!: () => void
    const blocked = new Promise<void>((resolve) => {
        release = resolve
    })
    const started = new Promise<void>((resolve) => {
        entered = resolve
    })
    let calls = 0
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (++calls === 1) {
            entered()
            await blocked
        }
        return rename(from, to)
    })
    const old = saveSession(root, snapshot('old unsaved text'))
    await started
    const final = saveSession(root, snapshot('new unsaved text'))
    await Promise.race([final, new Promise((resolve) => setTimeout(resolve, 30))])
    expect(calls).toBe(1)
    release()
    await Promise.all([old, final])
    expect((await loadSession(root))?.tabs[0].text).toBe('new unsaved text')
})

it('allows the next snapshot to persist after an earlier write fails', async () => {
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename')
        .mockRejectedValueOnce(Object.assign(new Error('disk failure'), { code: 'EIO' }))
        .mockImplementation(rename)
    const first = saveSession(root, snapshot('old')).catch((error) => error)
    await saveSession(root, snapshot('new'))
    expect(await first).toBeInstanceOf(Error)
    expect((await loadSession(root))?.tabs[0].text).toBe('new')
})

it('keeps the recovery marker when sanitizing a session', () => {
    expect(
        sanitizeSession({ tabs: [{ path: '/recovered.cpp', text: 'a', saved: 'a', missing: true }] })?.tabs[0]
    ).toMatchObject({ missing: true })
})
