import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileIOConfig } from '../../shared/problem'
import { defaultProblem } from '../../shared/problem'

const mocks = vi.hoisted(() => ({ save: vi.fn(async (_path: string, _patch: unknown) => {}), toast: vi.fn() }))
vi.mock('./problemWrites', () => ({ saveProblemSettings: mocks.save }))
vi.mock('../state/app', () => ({ toast: mocks.toast }))
import { fileIOFromCode, syncFileIO } from './fileIO'

const active = 'freopen("题目.in", "rb", stdin); freopen("题目.out", "wb", stdout);'
const current: FileIOConfig = { enabled: true, input: 'old.in', output: 'old.out', origin: 'freopen' }
beforeEach(() => {
    vi.clearAllMocks()
})

describe('file IO follows active freopen in both directions', () => {
    it('preserves automatic file IO settings while running in interactive mode', async () => {
        await syncFileIO('D:/sample.cpp', 'int main(){}', {
            ...defaultProblem('sample'),
            mode: 'interactive',
            fileIO: current
        })
        expect(mocks.save).not.toHaveBeenCalled()
        expect(mocks.toast).not.toHaveBeenCalled()
    })
    it.each(['int main() {}', `// ${active}`, `/* ${active} */`, `#if 0\n${active}\n#endif`])(
        'turns off automatic IO for removed or inactive calls: %s',
        (code) => {
            expect(fileIOFromCode(code, current)).toEqual({ ...current, enabled: false })
        }
    )
    it('closes legacy automatically-enabled IO without dropping the remembered names', () => {
        expect(
            fileIOFromCode('// freopen("old.in", "r", stdin);', { enabled: true, input: 'old.in', output: 'old.out' })
        ).toEqual({ ...current, enabled: false })
    })
    it('enables and updates the names when calls return', () => {
        expect(fileIOFromCode(active, { ...current, enabled: false })).toEqual({
            enabled: true,
            input: '题目.in',
            output: '题目.out',
            origin: 'freopen'
        })
    })
    it('keeps IO enabled while at least one active stdin/stdout call remains', () => {
        expect(fileIOFromCode('freopen("data.in", "r", stdin);', current)).toEqual({ ...current, input: 'data.in' })
    })
    it('preserves explicitly manual IO for programs using fstream', () => {
        const manual: FileIOConfig = { ...current, origin: 'manual' }
        expect(fileIOFromCode('std::ifstream input("old.in");', manual)).toBe(manual)
        expect(fileIOFromCode('', manual, true)).toEqual({ ...current, enabled: false })
    })
    it('persists disabling before resolving, against the captured source path', async () => {
        const problem = { ...defaultProblem('sample'), fileIO: current }
        await syncFileIO('D:/sample.cpp', '// disabled', problem)
        expect(mocks.save).toHaveBeenCalledExactlyOnceWith('D:/sample.cpp', { fileIO: { ...current, enabled: false } })
        expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('关闭'), 'info', 5000)
    })
    it('does not write unchanged standard IO or repeat an automatic update', async () => {
        await syncFileIO('D:/sample.cpp', 'int main(){}', defaultProblem('sample'))
        await syncFileIO('D:/sample.cpp', 'int main(){}', {
            ...defaultProblem('sample'),
            fileIO: { ...current, enabled: false }
        })
        expect(mocks.save).not.toHaveBeenCalled()
    })
    it('propagates persistence errors instead of running against a stale enabled setting', async () => {
        mocks.save.mockRejectedValueOnce(new Error('Cannot save configuration'))
        await expect(syncFileIO('D:/sample.cpp', '', { ...defaultProblem('sample'), fileIO: current })).rejects.toThrow(
            'Cannot save'
        )
    })
})
