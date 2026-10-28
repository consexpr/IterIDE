import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { loadProblem, patchProblem, writeTest, acquireProblemLease, problemDir } from './store'
import { checkerSettingsPatch, normalRunMode } from '../../shared/checkerSelection'
import { defaultSettings } from '../../shared/settings'
import { JudgeEngine } from '../judge/engine'
import { solutionBuild } from '../judge/modes/builtin/common'
import type { TestResult } from '../../shared/judge'

let root: string, src: string
const code = 'int solve(int x){return x+1;}'
beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-mode-switch-'))
    vi.stubEnv('ITER_STORE', path.join(root, 'store'))
    src = path.join(root, 'solution.cpp')
    await fs.writeFile(src, code)
})
afterEach(async () => {
    vi.unstubAllEnvs()
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('iter-mode-switch-'))
        throw Error('Unexpected test cleanup path')
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 })
})

async function judge(): Promise<TestResult> {
    let finish!: () => void, fail!: (error: Error) => void
    const done = new Promise<void>((resolve, reject) => {
        finish = resolve
        fail = reject
    })
    const results: TestResult[] = []
    const engine = new JudgeEngine(
        () => defaultSettings().toolchain,
        (event) => {
            if (event.type === 'test-done') results.push(event.result)
            if (event.type === 'done') finish()
            if (event.type === 'error') fail(Error(event.message))
        }
    )
    try {
        await engine.run({ sourcePath: src, source: code })
        await done
        expect(results).toHaveLength(1)
        return results[0]
    } finally {
        await engine.dispose()
    }
}

it('round-trips saved checker rules, files, arguments, grader and file IO through repeated real runs', async () => {
    const grader = path.join(root, 'grader.cpp'),
        checker = path.join(root, 'checker.cpp'),
        interactor = path.join(root, 'interactor.cpp')
    await fs.writeFile(
        grader,
        '#include <iostream>\nint solve(int);int main(){int x;std::cin>>x;std::cout<<solve(x)<<std::endl;}'
    )
    await fs.writeFile(
        checker,
        '// n-check 1\n#include <fstream>\n#include <iostream>\nint main(int,char**v){int a,b,c;std::ifstream(v[1])>>a;std::ifstream(v[2])>>b;std::ifstream(v[3])>>c;if(a!=4||b!=4||c!=3)return 3;std::cerr<<"custom-reject";return 1;}'
    )
    await fs.writeFile(
        interactor,
        '#include "testlib.h"\n#include <iostream>\nint main(int argc,char**argv){registerInteraction(argc,argv);int x=inf.readInt();std::cout<<x<<std::endl;if(ouf.readInt()!=x+1)quitf(_wa,"wrong");quitf(_ok,"correct");}'
    )
    await writeTest(src, { input: '3\n', answer: '4\n' })
    let cfg = await patchProblem(src, {
        grader: { sources: [grader] },
        checker: { kind: 'builtin', builtin: 'lines', value: 'float6' }
    })
    expect((await judge()).verdict).toBe('AC')
    cfg = await patchProblem(
        src,
        checkerSettingsPatch(cfg, { kind: 'custom', path: checker, args: '{answer} {output} {input}' })
    )
    const ownedChecker = cfg.checker.path,
        ownedGrader = cfg.grader
    expect(await judge()).toMatchObject({ verdict: 'WA', checkerMessage: 'custom-reject' })
    cfg = await patchProblem(src, checkerSettingsPatch(await loadProblem(src), { kind: 'builtin' }))
    expect(cfg.checker).toMatchObject({
        builtin: 'lines',
        value: 'float6',
        path: ownedChecker,
        args: '{answer} {output} {input}'
    })
    expect((await judge()).verdict).toBe('AC')
    cfg = await patchProblem(src, checkerSettingsPatch(await loadProblem(src), { kind: 'custom' }))
    expect(await judge()).toMatchObject({ verdict: 'WA', checkerMessage: 'custom-reject' })
    cfg = await patchProblem(src, {
        mode: 'interactive',
        interactor: { path: interactor },
        fileIO: { enabled: true, input: 'task.in', output: 'task.out', origin: 'manual' }
    })
    expect((await judge()).verdict).toBe('AC')
    cfg = await patchProblem(src, { mode: normalRunMode(cfg) })
    expect(cfg.fileIO).toMatchObject({ enabled: true, input: 'task.in', output: 'task.out' })
    expect(cfg.grader).toEqual(ownedGrader)
    expect(cfg.checker).toMatchObject({ path: ownedChecker, args: '{answer} {output} {input}' })
    cfg = await patchProblem(src, { fileIO: { ...cfg.fileIO, enabled: false } })
    expect(await judge()).toMatchObject({ verdict: 'WA', checkerMessage: 'custom-reject' })

    // An inactive missing tool cannot break saving, compilation or ordinary judging.
    cfg = await patchProblem(src, {
        ...checkerSettingsPatch(cfg, { kind: 'builtin' }),
        interactor: { path: path.join(root, 'missing.cpp') }
    })
    expect((await judge()).verdict).toBe('AC')
    await expect(patchProblem(src, { mode: 'interactive' })).rejects.toThrow()
    expect((await loadProblem(src)).mode).toBe(cfg.mode)
}, 30_000)

it('uses only the active tool include directories and does not require an inactive missing checker', async () => {
    let cfg = await loadProblem(src)
    const checker = path.join(root, 'checker-dir', 'checker.cpp'),
        interactor = path.join(root, 'interactor-dir', 'interactor.cpp')
    cfg = { ...cfg, checker: { kind: 'custom', path: checker }, interactor: { path: interactor } }
    const normal = solutionBuild({ sourcePath: src, sourceDir: root, problemDir: problemDir(src), problem: cfg })
    expect(normal.includeDirs).toContain(path.dirname(checker))
    expect(normal.includeDirs).not.toContain(path.dirname(interactor))
    cfg.mode = 'interactive'
    const interactive = solutionBuild({ sourcePath: src, sourceDir: root, problemDir: problemDir(src), problem: cfg })
    expect(interactive.includeDirs).toContain(path.dirname(interactor))
    expect(interactive.includeDirs).not.toContain(path.dirname(checker))
    await fs.mkdir(path.dirname(interactor))
    await fs.writeFile(interactor, 'int main(){}')
    const saved = await patchProblem(src, { mode: cfg.mode, checker: cfg.checker, interactor: cfg.interactor })
    expect(saved.checker.path).toBe(checker)
})

it('blocks execution configuration changes while a run holds the problem lease', async () => {
    const before = await loadProblem(src)
    const release = await acquireProblemLease(src)
    try {
        await expect(patchProblem(src, { mode: 'interactive' })).rejects.toThrow()
        await expect(patchProblem(src, { checker: { kind: 'custom', path: 'checker.cpp' } })).rejects.toThrow()
    } finally {
        release()
    }
    expect((await loadProblem(src)).mode).toBe(before.mode)
})

it('does not reuse the previous checker argument template or source-relative path for a new file', async () => {
    const cfg = await loadProblem(src)
    cfg.checker = {
        kind: 'custom',
        path: 'old.cpp',
        relativeTo: 'source',
        args: '{answer} {input} {output}',
        builtin: 'lines',
        value: 'float9'
    }
    const next = checkerSettingsPatch(cfg, { kind: 'custom', path: 'resources/new.cpp' }).checker!
    expect(next.args).toBeUndefined()
    expect(next.relativeTo).toBeUndefined()
    expect(next).toMatchObject({ builtin: 'lines', value: 'float9' })
})
