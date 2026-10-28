import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type {
    ProblemConfig,
    ProblemSettingsPatch,
    TestCaseData,
    TestCaseMeta,
    TestMetaPatch
} from '../../shared/problem'
import type { JudgeSourceFile } from '../../shared/problem'
import { publishInteractorFiles, readInteractorFiles } from './interactorFiles'
import { previewFile } from './files'
import { atomicCopy, atomicWrite, copyDirectory } from './atomic'
import { normalize } from './config'
import { scanCpp } from '../importer/source-analysis'
import { resourceFlags, mapResourceFlagPaths } from './resourceFlags'
import { captureResources } from './resources'
import { resourceStrings } from './resourceRuntime'
import { collectResources } from './resourceGc'
import { N_CHECK_FILE } from '../../shared/nCheck'
import { inspectCheckerSource } from '../../shared/checkerSource'
import { activeJudgeTools } from '../../shared/checkerSelection'
import {
    absolutePath,
    bindIdentity,
    directoryForId,
    legacyProblemDir,
    pathKey,
    readIndex,
    readMeta,
    resolveIdentity,
    validId,
    writeIndex,
    type Binding
} from './identity'
import { commitImportTransaction, createImportTransaction, recoverTransactions } from './transaction'

export { atomicWrite } from './atomic'
export { existingProblemDir } from './identity'

const locks = new Map<string, Promise<unknown>>()
const leases = new Map<string, number>()
function assertIdle(dir: string): void {
    if (leases.get(pathKey(dir))) throw new Error('题目正在运行或调试，请结束后再修改运行配置或题目数据')
}
async function lockedId<T>(dir: string, action: () => Promise<T>): Promise<T> {
    const key = pathKey(dir)
    const next = (locks.get(key) ?? Promise.resolve())
        .catch(() => {})
        .then(async () => {
            const result = await action()
            // Maintenance cannot turn an already committed save into a reported failure.
            try {
                const config = await readConfig(path.join(dir, 'problem.json'))
                if (config) await collectResources(dir, config, !!leases.get(key))
            } catch {
                /* Retry on the next successful operation. */
            }
            return result
        })
    locks.set(key, next)
    try {
        return await next
    } catch (error) {
        throw new Error(`无法读写题目数据：${(error as Error).message}`, { cause: error })
    } finally {
        if (locks.get(key) === next) locks.delete(key)
    }
}
async function locked<T>(src: string, action: (binding: Binding) => Promise<T>): Promise<T> {
    const binding = resolveIdentity(src)
    return lockedId(binding.dir, () => action(binding))
}

export function problemDir(sourcePath: string): string {
    return resolveIdentity(sourcePath).dir
}
/** Code history shares the source identity and lock, including Save As and deletion. */
export function withSourceStorage<T>(sourcePath: string, action: (directory: string) => Promise<T>): Promise<T> {
    return locked(sourcePath, (binding) => action(binding.dir))
}
/** Reassert after saving with an editor strategy which may replace the underlying file. */
export async function ensureIdentity(sourcePath: string): Promise<void> {
    resolveIdentity(sourcePath)
}

/** Acquire under the same lock as imports, so checking and starting a run cannot race. */
export async function acquireProblemLease(sourcePath: string): Promise<() => void> {
    return locked(sourcePath, async (binding) => {
        await load(sourcePath, binding)
        const key = pathKey(binding.dir)
        leases.set(key, (leases.get(key) ?? 0) + 1)
        let released = false
        return () => {
            if (released) return
            released = true
            const count = (leases.get(key) ?? 1) - 1
            if (count) leases.set(key, count)
            else leases.delete(key)
        }
    })
}

export function testFilePaths(src: string, id: string): { input: string; answer: string } {
    if (!validId(id)) throw new Error(`无效的测试 ID (Invalid test id): ${id}`)
    const dir = path.join(problemDir(src), 'tests')
    return { input: path.join(dir, `${id}.in`), answer: path.join(dir, `${id}.ans`) }
}
export function testDataPaths(src: string, test: TestCaseMeta): { input: string; answer?: string } {
    return testFilePaths(src, test.id)
}

/** Keep external references anchored when the solution moves; relocate owned absolute grader paths on copies. */
function relocate(cfg: ProblemConfig, oldSource: string, oldDir: string, source: string, dir: string): ProblemConfig {
    const moved = pathKey(oldSource) !== pathKey(source)
    const convert = (file: string): string => {
        const previousPaths = path.win32.isAbsolute(oldSource) && !path.isAbsolute(oldSource) ? path.win32 : path
        const candidate = previousPaths.resolve(previousPaths.dirname(oldSource), file),
            rel = path.relative(oldDir, candidate)
        if (path.isAbsolute(candidate) && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
            return path.join(dir, rel)
        // Synced stores can have a different home/volume/OS. Owned files are identified by the exact
        // problems/<id> component, not by their old machine's absolute store prefix.
        if (absolutePath(file) && path.basename(path.dirname(oldDir)) === 'problems') {
            const marker = `/problems/${path.basename(oldDir)}`,
                portable = file.replaceAll('\\', '/')
            const offset = portable.lastIndexOf(marker)
            if (offset >= 0) {
                const suffix = portable.slice(offset + marker.length)
                if (suffix === '') return dir
                const parts = suffix.slice(1).split('/')
                if (suffix.startsWith('/') && parts.every((part) => part && part !== '.' && part !== '..'))
                    return path.join(dir, ...parts)
            }
        }
        return moved ? previousPaths.resolve(previousPaths.dirname(oldSource), file) : file
    }
    if (cfg.checker.path)
        cfg.checker.path =
            cfg.checker.relativeTo === 'source' || absolutePath(cfg.checker.path)
                ? convert(cfg.checker.path)
                : cfg.checker.path
    if (cfg.interactor) {
        cfg.interactor.path =
            cfg.interactor.relativeTo === 'source' || absolutePath(cfg.interactor.path)
                ? convert(cfg.interactor.path)
                : cfg.interactor.path
        cfg.interactor.files = cfg.interactor.files?.map((file) =>
            cfg.interactor!.relativeTo === 'source' || absolutePath(file) ? convert(file) : file
        )
    }
    if (cfg.grader) {
        cfg.grader.sources = cfg.grader.sources.map(convert)
        cfg.grader.includeDirs = cfg.grader.includeDirs?.map(convert)
    }
    if (cfg.extraFlags) cfg.extraFlags = mapResourceFlagPaths(cfg.extraFlags, convert)
    return cfg
}

async function metadata(src: string, binding: Binding, title: string): Promise<void> {
    const old = readMeta(binding.dir),
        now = Date.now()
    await atomicWrite(
        path.join(binding.dir, 'meta.json'),
        JSON.stringify(
            {
                id: binding.id,
                sourcePath: path.resolve(src),
                title,
                createdAt: old?.id === binding.id ? old.createdAt : now,
                updatedAt: now
            },
            null,
            2
        ) + '\n'
    )
}
async function snapshot(src: string, binding: Binding, code?: string): Promise<void> {
    let bytes: string | Buffer
    try {
        bytes = code ?? (await fs.readFile(src))
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
    }
    await atomicWrite(path.join(binding.dir, 'code.cpp'), bytes)
    bindIdentity(src, binding.id)
}
async function cacheResources(src: string, cfg: ProblemConfig, dir: string, code?: string): Promise<void> {
    const owned = (file: string, anchor = dir): boolean => {
        const relative = path.relative(dir, path.resolve(anchor, file)).replaceAll('\\', '/')
        return relative.startsWith('resources/') && !relative.split('/').includes('..')
    }
    const base = path.dirname(path.resolve(src))
    const flags = await resourceFlags(src, cfg.extraFlags)
    for (const ref of activeJudgeTools(cfg)) {
        if (!ref?.path) continue
        const anchor = ref.relativeTo === 'source' ? base : dir
        if ([ref.path, ...(ref.files ?? [])].every((file) => owned(file, anchor))) continue
        const original = path.resolve(anchor, ref.path)
        const companions = ref.files?.map((file) => path.resolve(anchor, file))
        const bundle = await captureResources(dir, [original, ...(companions ?? [])], [base])
        ref.path = bundle.file(original).replaceAll('\\', '/')
        if (companions) ref.files = companions.map((file) => bundle.file(file).replaceAll('\\', '/'))
        delete ref.relativeTo
    }
    if (cfg.grader && cfg.grader.sources.some((file) => !owned(file, base))) {
        const sources = cfg.grader.sources.map((file) => path.resolve(base, file))
        const includes = [
            base,
            ...flags.includeDirs,
            ...(cfg.grader.includeDirs ?? []).map((file) => path.resolve(base, file))
        ]
        const bundle = await captureResources(dir, sources, includes, undefined, undefined, cfg.extraFlags)
        cfg.grader = {
            sources: sources.map((file) => path.join(dir, bundle.file(file))),
            includeDirs: bundle.includeDirs.map((file) => path.join(dir, file))
        }
    }
    const compileKey = (): string =>
        createHash('sha256')
            .update(JSON.stringify([cfg.grader?.includeDirs, cfg.extraFlags]))
            .digest('hex')
    const text =
        code ??
        (cfg.cachedIncludes !== undefined && cfg.cachedSourceKey?.startsWith(compileKey() + ':')
            ? undefined
            : await fs.readFile(src, 'utf8').catch((error: NodeJS.ErrnoException) => {
                  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
                  throw error
              }))
    const sourceKey = (): string =>
        compileKey() +
        ':' +
        createHash('sha256')
            .update(
                JSON.stringify([
                    scanCpp(text ?? '').includes,
                    (text ?? '').match(/^[\t ]*#[^\n]*/gm),
                    resourceStrings(text ?? '')
                ])
            )
            .digest('hex')
    if (text !== undefined && (cfg.cachedIncludes === undefined || cfg.cachedSourceKey !== sourceKey())) {
        const exists =
            code !== undefined ||
            (await fs.stat(src).then(
                (info) => info.isFile(),
                (error) => {
                    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false
                    throw error
                }
            ))
        if (exists) {
            const dirs = [
                base,
                ...flags.includeDirs,
                ...flags.directories,
                ...(cfg.grader?.includeDirs ?? []),
                ...(cfg.cachedIncludes ?? []).map((file) => path.join(dir, file))
            ]
            try {
                const bundle = await captureResources(
                    dir,
                    [src, ...flags.entries],
                    dirs,
                    undefined,
                    new Map([[path.resolve(src), text]]),
                    cfg.extraFlags
                )
                if (cfg.extraFlags) cfg.extraFlags = flags.rewrite((file) => path.join(dir, bundle.file(file)))
                cfg.cachedIncludes = bundle.includeDirs.map((file) => file.replaceAll('\\', '/'))
                cfg.cachedSourceKey = sourceKey()
                cfg.cachedHeaders = bundle.headers(src)
                cfg.cachedRuntime = bundle.runtime(src)
            } catch (error) {
                // Half-written code must remain editable and recoverable. Compilation reports unresolved headers.
                if (!(error instanceof Error) || !error.message.startsWith('题目依赖不存在：')) throw error
            }
        }
    }
}
async function save(src: string, cfg: ProblemConfig, binding: Binding): Promise<void> {
    await cacheResources(src, cfg, binding.dir)
    await atomicWrite(path.join(binding.dir, 'problem.json'), JSON.stringify(cfg, null, 2) + '\n')
    await snapshot(src, binding)
    await metadata(src, binding, cfg.title)
}

async function readConfig(file: string): Promise<unknown> {
    let bytes: Buffer
    try {
        bytes = await fs.readFile(file)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
    }
    try {
        const value: unknown = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SyntaxError('配置根节点必须是对象')
        return value
    } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        const hash = createHash('sha256').update(bytes).digest('hex')
        const backup = `${file}.corrupt-${hash}.json`
        try {
            const handle = await fs.open(backup, 'wx')
            try {
                await handle.writeFile(bytes)
                await handle.sync()
            } finally {
                await handle.close()
            }
        } catch (failure) {
            if ((failure as NodeJS.ErrnoException).code !== 'EEXIST' || !(await fs.readFile(backup)).equals(bytes))
                throw new Error('题目配置 JSON 已损坏，无法保存恢复副本；原文件未改动', { cause: failure })
        }
        throw new Error(`题目配置 JSON 已损坏，原文件未改动。恢复副本：${backup}`, { cause: error })
    }
}
async function refreshDerived(src: string, binding: Binding, preserveSourceAnchor = false): Promise<void> {
    // Recovery may precede relocation after a source move. Keep the old anchor until load()
    // has converted source-relative checker/grader paths; otherwise metadata would hide the move.
    const anchor = preserveSourceAnchor ? readMeta(binding.dir)?.sourcePath || src : src
    const cfg = normalize(anchor, await readConfig(path.join(binding.dir, 'problem.json')))
    await snapshot(src, binding)
    await metadata(anchor, binding, cfg.title)
}

async function load(
    src: string,
    binding: Binding,
    report: (message: string) => void = console.warn,
    linkedImport?: TestCaseMeta['link'] | NonNullable<TestCaseMeta['link']>[],
    persist = true
): Promise<ProblemConfig> {
    src = path.resolve(src)
    const dir = binding.dir,
        file = path.join(dir, 'problem.json')
    const recovery = await recoverTransactions(dir, () => refreshDerived(src, binding, true), report)
    let raw: unknown,
        migrated = false
    try {
        await fs.access(file)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        const legacy = legacyProblemDir(src)
        if (
            await fs.stat(legacy).then(
                (s) => s.isDirectory(),
                (e) => {
                    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false
                    throw e
                }
            )
        ) {
            await copyDirectory(legacy, dir)
            migrated = true
        }
    }
    await fs.mkdir(path.join(dir, 'tests'), { recursive: true })
    raw = await readConfig(file)
    const meta = readMeta(dir)
    const oldSource = meta?.sourcePath || src
    const cfg = relocate(
        normalize(oldSource, raw),
        oldSource,
        migrated ? legacyProblemDir(src) : meta?.id ? directoryForId(meta.id) : dir,
        src,
        dir
    )
    // Repair a changed answer before reconciliation can discard the old link (e.g. .out renamed .ans).
    const repairs = linkedImport ? (Array.isArray(linkedImport) ? linkedImport : [linkedImport]) : []
    for (const repair of repairs) {
        const existing = cfg.tests.find((test) => test.link && pathKey(test.link.input) === pathKey(repair.input))
        if (existing?.link) {
            if (repair.answer === undefined) delete existing.link.answer
            else if (existing.link.answer === undefined || pathKey(existing.link.answer) !== pathKey(repair.answer))
                existing.link.answer = repair.answer
        }
    }
    await cacheResources(src, cfg, dir)
    for (const test of cfg.tests) {
        if (!test.link) continue
        const targets = testFilePaths(src, test.id)
        for (const [original, target] of [
            [test.link.input, targets.input],
            [test.link.answer, targets.answer]
        ] as const) {
            const present = await fs.access(target).then(
                () => true,
                () => false
            )
            if (present) continue
            if (original) {
                try {
                    await atomicCopy(original, target)
                } catch (error) {
                    throw new Error('无法缓存题目数据：' + original, { cause: error })
                }
            } else await atomicWrite(target, '')
        }
    }
    const files = await fs.readdir(path.join(dir, 'tests'), { withFileTypes: true })
    const inputs = new Set(
        files
            .filter((f) => f.isFile() && f.name.endsWith('.in') && !recovery.retired.has(`tests/${f.name}`))
            .map((f) => f.name.slice(0, -3))
            .filter(validId)
    )
    const retained: TestCaseMeta[] = []
    for (const test of cfg.tests) {
        if (inputs.has(test.id)) {
            retained.push(test)
            continue
        }
        if (test.link) throw new Error('缓存测试输入不存在：' + test.id)
    }
    cfg.tests = retained
    const listed = new Set(cfg.tests.map((t) => t.id))
    for (const id of [...inputs].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
        if (!listed.has(id)) cfg.tests.push({ id, name: id, enabled: true })
    }
    const comparable = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : raw
    if (comparable && typeof comparable === 'object') delete (comparable as Record<string, unknown>).storageTransaction
    if (persist && JSON.stringify(comparable) !== JSON.stringify(cfg)) await save(src, cfg, binding)
    else if (
        persist &&
        (!meta || meta.id !== binding.id || pathKey(meta.sourcePath) !== pathKey(src) || meta.title !== cfg.title)
    ) {
        await snapshot(src, binding)
        await metadata(src, binding, cfg.title)
    }
    return cfg
}

export async function loadProblem(
    sourcePath: string,
    report?: (message: string) => void,
    code?: string
): Promise<ProblemConfig> {
    return locked(sourcePath, async (binding) => {
        const cfg = await load(sourcePath, binding, report)
        if (code !== undefined) {
            await cacheResources(sourcePath, cfg, binding.dir, code)
            await atomicWrite(path.join(binding.dir, 'problem.json'), JSON.stringify(cfg, null, 2) + '\n')
            await snapshot(sourcePath, binding, code)
        }
        return cfg
    })
}
export async function saveProblem(sourcePath: string, cfg: ProblemConfig): Promise<void> {
    return locked(sourcePath, async (binding) => {
        await load(sourcePath, binding)
        await save(sourcePath, normalize(sourcePath, cfg), binding)
    })
}
export async function patchProblem(sourcePath: string, patch: ProblemSettingsPatch): Promise<ProblemConfig> {
    return locked(sourcePath, async (binding) => {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch) || 'tests' in patch || 'version' in patch)
            throw new Error('题目设置补丁不能包含 tests 或 version')
        if (
            ['mode', 'checker', 'interactor', 'grader', 'fileIO', 'extraFlags'].some((key) => Object.hasOwn(patch, key))
        )
            assertIdle(binding.dir)
        const current = await load(sourcePath, binding)
        const cfg = normalize(sourcePath, { ...current, ...patch, tests: current.tests, version: current.version })
        await save(sourcePath, cfg, binding)
        return cfg
    })
}
export async function updateTestMeta(sourcePath: string, id: string, patch: TestMetaPatch): Promise<ProblemConfig> {
    return locked(sourcePath, async (binding) => {
        if (
            !validId(id) ||
            !patch ||
            typeof patch !== 'object' ||
            Array.isArray(patch) ||
            Object.keys(patch).some((key) => !['name', 'enabled', 'sample', 'timeLimit', 'compareOutput'].includes(key))
        )
            throw new Error('无效的测试元数据补丁')
        if (
            (Object.hasOwn(patch, 'name') && typeof patch.name !== 'string') ||
            (Object.hasOwn(patch, 'enabled') && typeof patch.enabled !== 'boolean') ||
            (Object.hasOwn(patch, 'compareOutput') && typeof patch.compareOutput !== 'boolean') ||
            (patch.sample !== undefined && typeof patch.sample !== 'boolean') ||
            (patch.timeLimit !== undefined && (!Number.isFinite(patch.timeLimit) || patch.timeLimit <= 0))
        )
            throw new Error('测试元数据类型无效或时间限制不是正数')
        if (Object.hasOwn(patch, 'compareOutput')) assertIdle(binding.dir)
        const cfg = await load(sourcePath, binding),
            test = cfg.tests.find((test) => test.id === id)
        if (!test) throw new Error('测试点已不存在，请刷新后重试')
        if (patch.compareOutput === true && test.compareOutput === false && test.link?.answer) {
            const available = await fs.stat(testDataPaths(sourcePath, test).answer!).then(
                (info) => info.isFile(),
                (error: NodeJS.ErrnoException) => {
                    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false
                    throw error
                }
            )
            if (!available) throw new Error('期望输出文件不存在，请恢复文件或编辑期望输出后再启用比较')
        }
        Object.assign(test, patch)
        const normalized = normalize(sourcePath, cfg)
        await save(sourcePath, normalized, binding)
        return normalized
    })
}

export interface BatchTest {
    name: string
    sample?: boolean
    input?: (target: string) => Promise<void>
    answer?: (target: string) => Promise<void>
    link?: NonNullable<TestCaseMeta['link']>
}
export interface ProblemImportBatch {
    replace: boolean
    tests: BatchTest[]
    attachments?: {
        role: 'checker' | 'interactor'
        extension: '.cpp' | '.exe'
        write(target: string): Promise<void>
        capture?(directory: string): Promise<string>
    }[]
    configure?: (config: ProblemConfig) => void
}
/** One lock and one configuration commit for tests, metadata and owned attachments. */
export async function importProblemBatch(
    sourcePath: string,
    batch: ProblemImportBatch,
    report: (message: string) => void = console.warn
): Promise<{ added: number }> {
    return locked(sourcePath, async (binding) => {
        assertIdle(binding.dir)
        const cfg = await load(
            sourcePath,
            binding,
            report,
            batch.tests.flatMap((test) => (test.link ? [test.link] : [])),
            false
        )
        const previous = structuredClone(cfg.tests)
        if (batch.replace) cfg.tests = []
        const transaction = await createImportTransaction(binding.dir)
        const added: string[] = []
        const replaced: string[] = []
        const imported = new Set<string>()
        let count = 0,
            submitted = false
        try {
            for (const [index, incoming] of batch.tests.entries()) {
                const existing =
                    incoming.link &&
                    cfg.tests.find((test) => test.link && pathKey(test.link.input) === pathKey(incoming.link!.input))
                if (incoming.link && imported.has(pathKey(incoming.link.input))) continue
                if (incoming.link) imported.add(pathKey(incoming.link.input))
                const id = existing?.id ?? `import-${transaction.id}-${index}`
                const test: TestCaseMeta = existing ?? {
                    id,
                    name: incoming.name,
                    enabled: true,
                    ...(incoming.sample ? { sample: true } : {})
                }
                if (incoming.link)
                    test.link = {
                        input: path.resolve(incoming.link.input),
                        ...(incoming.link.answer === undefined ? {} : { answer: path.resolve(incoming.link.answer) })
                    }
                {
                    if (!incoming.input && !incoming.link) throw new Error('导入测试缺少输入文件')
                    for (const extension of ['in', 'ans'] as const) {
                        const relative = `tests/${id}.${extension}`,
                            target = path.join(transaction.stage, ...relative.split('/'))
                        await fs.mkdir(path.dirname(target), { recursive: true })
                        const write = extension === 'in' ? incoming.input : incoming.answer
                        if (write) await write(target)
                        else if (incoming.link && (extension === 'in' ? incoming.link.input : incoming.link.answer))
                            await atomicCopy((extension === 'in' ? incoming.link.input : incoming.link.answer)!, target)
                        else await atomicWrite(target, '')
                        if (existing) replaced.push(relative)
                        else added.push(relative)
                    }
                }
                if (!existing) {
                    cfg.tests.push(test)
                    count++
                }
            }
            for (const attachment of batch.attachments ?? []) {
                const relative = `judge/import-${transaction.id}-${attachment.role}${attachment.extension}`
                const target = path.join(transaction.stage, ...relative.split('/'))
                await fs.mkdir(path.dirname(target), { recursive: true })
                let captured = attachment.capture ? await attachment.capture(binding.dir) : undefined
                if (!captured) {
                    await attachment.write(target)
                    const bundle = await captureResources(binding.dir, [target], [path.dirname(sourcePath)])
                    captured = bundle.file(target).replaceAll('\\', '/')
                    added.push(relative)
                }
                if (attachment.role === 'checker') {
                    cfg.checker = { kind: 'custom', path: captured ?? relative }
                    cfg.mode = 'spj'
                } else {
                    cfg.interactor = { path: captured ?? relative }
                    cfg.mode = 'interactive'
                }
            }
            batch.configure?.(cfg)
            await cacheResources(sourcePath, cfg, binding.dir)
            const normalized = normalize(sourcePath, cfg),
                retained = new Set(normalized.tests.map((test) => test.id))
            const retired = previous
                .filter((test) => !retained.has(test.id))
                .flatMap((test) => [`tests/${test.id}.in`, `tests/${test.id}.ans`])
            submitted = true
            await commitImportTransaction(
                transaction,
                Buffer.from(JSON.stringify(normalized, null, 2) + '\n'),
                added,
                retired,
                () => refreshDerived(sourcePath, binding),
                report,
                replaced
            )
            return { added: count }
        } finally {
            // Once journaled, only the recovery protocol may remove the stage and its evidence.
            if (!submitted) await fs.rm(transaction.stage, { recursive: true, force: true })
        }
    })
}
export async function snapshotCode(sourcePath: string, code: string): Promise<void> {
    return locked(sourcePath, async (binding) => {
        const cfg = await load(sourcePath, binding)
        await cacheResources(sourcePath, cfg, binding.dir, code)
        await atomicWrite(path.join(binding.dir, 'problem.json'), JSON.stringify(cfg, null, 2) + '\n')
        await snapshot(sourcePath, binding, code)
        await metadata(sourcePath, binding, cfg.title)
    })
}
export const TEST_PREVIEW_TOTAL_CHARS = 4_000_000
const TEST_READ_CONCURRENCY = 8

async function mapTests<T>(tests: TestCaseMeta[], read: (test: TestCaseMeta) => Promise<T>): Promise<T[]> {
    const result = new Array<T>(tests.length)
    let next = 0
    const workers = await Promise.allSettled(
        Array.from({ length: Math.min(TEST_READ_CONCURRENCY, tests.length) }, async () => {
            while (next < tests.length) {
                const index = next++
                result[index] = await read(tests[index])
            }
        })
    )
    const failure = workers.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure) throw failure.reason
    return result
}

async function testPreview(sourcePath: string, test: TestCaseMeta, limit: number): Promise<TestCaseData> {
    const paths = testDataPaths(sourcePath, test)
    const [input, answer] = await Promise.all([previewFile(paths.input, limit), previewFile(paths.answer, limit)])
    return {
        ...test,
        input: input.text,
        answer: answer.text,
        inputSize: input.size,
        answerSize: answer.size,
        truncated: input.truncated || answer.truncated,
        previewLoaded: true
    }
}

/** Listing never opens dataset contents. Expanded cards request their own bounded preview. */
export async function listTests(sourcePath: string): Promise<TestCaseData[]> {
    return locked(sourcePath, async (binding) => {
        const cfg = await load(sourcePath, binding)
        const size = async (file?: string): Promise<number> => {
            if (!file) return 0
            try {
                return (await fs.stat(file)).size
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
                throw error
            }
        }
        return mapTests(cfg.tests, async (test) => {
            const files = testDataPaths(sourcePath, test)
            const [inputSize, answerSize] = await Promise.all([size(files.input), size(files.answer)])
            return {
                ...test,
                input: '',
                answer: '',
                inputSize,
                answerSize,
                truncated: inputSize > 0 || answerSize > 0,
                previewLoaded: false
            }
        })
    })
}

export async function readTest(sourcePath: string, id: string, displayLimit: number): Promise<TestCaseData> {
    if (!validId(id)) throw new Error(`无效的测试 ID (Invalid test id): ${id}`)
    return locked(sourcePath, async (binding) => {
        const cfg = await load(sourcePath, binding)
        const test = cfg.tests.find((test) => test.id === id)
        if (!test) throw new Error('测试点已不存在，请刷新后重试')
        const limit = Number.isFinite(displayLimit) ? Math.max(0, Math.floor(displayLimit)) : 20_000
        return testPreview(sourcePath, test, Math.min(limit, TEST_PREVIEW_TOTAL_CHARS / 2))
    })
}

/** Compatibility API: both concurrent file reads and the aggregate returned text are bounded. */
export async function readTests(sourcePath: string, displayLimit: number): Promise<TestCaseData[]> {
    return locked(sourcePath, async (binding) => {
        const cfg = await load(sourcePath, binding)
        const requested = Number.isFinite(displayLimit) ? Math.max(0, Math.floor(displayLimit)) : 20_000
        const limit = Math.min(requested, Math.floor(TEST_PREVIEW_TOTAL_CHARS / Math.max(1, cfg.tests.length * 2)))
        return mapTests(cfg.tests, (test) => testPreview(sourcePath, test, limit))
    })
}
export async function writeTest(
    sourcePath: string,
    t: { id?: string; name?: string; input: string; answer: string }
): Promise<string> {
    return locked(sourcePath, async (binding) => {
        assertIdle(binding.dir)
        const cfg = await load(sourcePath, binding)
        const id =
            t.id ??
            String(cfg.tests.reduce((max, x) => (/^\d+$/.test(x.id) ? Math.max(max, Number(x.id)) : max), 0) + 1)
        if (!validId(id)) throw new Error(`无效的测试 ID (Invalid test id): ${id}`)
        const existing = cfg.tests.find((x) => x.id === id)
        if (existing) {
            delete existing.link
            if (t.name !== undefined) existing.name = t.name
        } else cfg.tests.push({ id, name: t.name ?? id, enabled: true })
        const transaction = await createImportTransaction(binding.dir)
        let submitted = false
        try {
            const replaced = [`tests/${id}.in`, `tests/${id}.ans`]
            await atomicWrite(path.join(transaction.stage, replaced[0]), t.input)
            await atomicWrite(path.join(transaction.stage, replaced[1]), t.answer)
            submitted = true
            await commitImportTransaction(
                transaction,
                Buffer.from(JSON.stringify(cfg, null, 2) + '\n'),
                [],
                [],
                () => refreshDerived(sourcePath, binding),
                console.warn,
                replaced
            )
        } finally {
            if (!submitted) await fs.rm(transaction.stage, { recursive: true, force: true })
        }
        return id
    })
}
export async function deleteTests(sourcePath: string, ids: string[]): Promise<void> {
    return locked(sourcePath, async (binding) => {
        assertIdle(binding.dir)
        const cfg = await load(sourcePath, binding)
        for (const id of ids) if (!validId(id)) throw new Error(`无效的测试 ID (Invalid test id): ${id}`)
        const retired = cfg.tests
            .filter((test) => ids.includes(test.id))
            .flatMap((test) => [`tests/${test.id}.in`, `tests/${test.id}.ans`])
        cfg.tests = cfg.tests.filter((t) => !ids.includes(t.id))
        const transaction = await createImportTransaction(binding.dir)
        await commitImportTransaction(transaction, Buffer.from(JSON.stringify(cfg, null, 2) + '\n'), [], retired, () =>
            refreshDerived(sourcePath, binding)
        )
    })
}
export async function importTestFiles(
    sourcePath: string,
    test: { name: string; input: string; answer?: string; sample?: boolean },
    link: boolean
): Promise<string> {
    return locked(sourcePath, async (binding) => {
        assertIdle(binding.dir)
        const linkedData = link
            ? {
                  input: path.resolve(test.input),
                  ...(test.answer === undefined ? {} : { answer: path.resolve(test.answer) })
              }
            : undefined
        const cfg = await load(sourcePath, binding, undefined, linkedData)
        if (linkedData) {
            const existing = cfg.tests.find(
                (test) => test.link && pathKey(test.link.input) === pathKey(linkedData.input)
            )
            if (existing) {
                const targets = testFilePaths(sourcePath, existing.id)
                await atomicCopy(test.input, targets.input)
                if (test.answer) await atomicCopy(test.answer, targets.answer)
                else await atomicWrite(targets.answer, '')
                await save(sourcePath, cfg, binding)
                return existing.id
            }
        }
        const id = randomUUID()
        const meta: TestCaseMeta = { id, name: test.name, enabled: true, ...(test.sample ? { sample: true } : {}) }
        if (linkedData) meta.link = linkedData
        {
            const paths = testFilePaths(sourcePath, id)
            try {
                await atomicCopy(test.input, paths.input)
                if (test.answer === undefined) await atomicWrite(paths.answer, '')
                else await atomicCopy(test.answer, paths.answer)
            } catch (error) {
                await Promise.all([fs.rm(paths.input, { force: true }), fs.rm(paths.answer, { force: true })])
                throw error
            }
        }
        cfg.tests.push(meta)
        await save(sourcePath, cfg, binding)
        return id
    })
}
export async function attachFile(sourcePath: string, file: string, role: 'checker' | 'interactor'): Promise<string> {
    return locked(sourcePath, async (binding) => {
        assertIdle(binding.dir)
        await load(sourcePath, binding)
        if (role === 'checker' && /\.(?:c|cc|cpp|cxx)$/i.test(file)) {
            if ((await fs.stat(file)).size > 16 * 1024 * 1024) throw new Error('Checker 源文件超过 16 MiB')
            const protocol = inspectCheckerSource(await fs.readFile(file, 'utf8'))
            if (protocol.kind === 'invalid') throw new Error(protocol.message)
        }
        const bundle = await captureResources(binding.dir, [path.resolve(file)], [path.dirname(sourcePath)])
        return bundle.file(file).replaceAll('\\', '/')
    })
}

/** Pasted checker source (n-check or testlib); keep the historical filename for compatibility. */
export async function attachCode(sourcePath: string, code: string): Promise<string> {
    return locked(sourcePath, async (binding) => {
        assertIdle(binding.dir)
        const cfg = await load(sourcePath, binding)
        const protocol = inspectCheckerSource(code)
        if (protocol.kind === 'invalid') throw new Error(protocol.message)
        if (cfg.checker.path && /\.(?:c|cc|cpp|cxx)$/i.test(cfg.checker.path)) {
            const original = path.resolve(
                cfg.checker.relativeTo === 'source' ? path.dirname(sourcePath) : binding.dir,
                cfg.checker.path
            )
            // Preserve imported companion headers/assets and publish a fresh bundle, never mutate the originals.
            const bundle = await captureResources(
                binding.dir,
                [original],
                [path.dirname(sourcePath)],
                undefined,
                new Map([[original, code]])
            )
            return bundle.file(original).replaceAll('\\', '/')
        }
        await atomicWrite(path.join(binding.dir, N_CHECK_FILE), code)
        return N_CHECK_FILE
    })
}

export async function readChecker(sourcePath: string): Promise<string | null> {
    return locked(sourcePath, async (binding) => {
        const cfg = await load(sourcePath, binding)
        const ref = cfg.checker
        if (!ref.path || !/\.(?:c|cc|cpp|cxx)$/i.test(ref.path)) return null
        const file = path.resolve(ref.relativeTo === 'source' ? path.dirname(sourcePath) : binding.dir, ref.path)
        if ((await fs.stat(file)).size > 16 * 1024 * 1024) throw new Error('Checker 源文件超过 16 MiB')
        return fs.readFile(file, 'utf8')
    })
}

export async function readInteractor(sourcePath: string): Promise<JudgeSourceFile[] | null> {
    return locked(sourcePath, async (binding) => {
        const cfg = await load(sourcePath, binding)
        return readInteractorFiles(binding.dir, sourcePath, cfg.interactor)
    })
}

export async function writeInteractor(
    sourcePath: string,
    files: JudgeSourceFile[],
    args?: string
): Promise<ProblemConfig> {
    return locked(sourcePath, async (binding) => {
        assertIdle(binding.dir)
        const cfg = await load(sourcePath, binding)
        cfg.interactor = await publishInteractorFiles(binding.dir, files, args, cfg.interactor)
        cfg.mode = 'interactive'
        await save(sourcePath, cfg, binding)
        return cfg
    })
}

/** Read back a file previously attached to this problem; only plain names inside its directory. */
export async function readAttached(sourcePath: string, name: string): Promise<string | null> {
    if (name !== path.basename(name) && !/^resources\/[a-f0-9-]{36}\/[a-f0-9]{16}\/[^\\/:]+$/.test(name)) return null
    return locked(sourcePath, async (binding) => fs.readFile(path.join(binding.dir, name), 'utf8').catch(() => null))
}

/** The solution moved to `to` (which must already exist): its tests and settings follow it. */
export async function moveSource(from: string, to: string): Promise<void> {
    const binding = resolveIdentity(from),
        dest = path.resolve(to)
    return lockedId(binding.dir, async () => {
        assertIdle(binding.dir)
        // Overwriting a file replaces whatever tests it had.
        const index = readIndex()
        for (const id of Object.keys(index))
            if (id !== binding.id && pathKey(index[id]) === pathKey(dest)) await removeProblem(id)
        bindIdentity(dest, binding.id)
        await load(dest, binding)
    })
}
/** Delete the stored problem bound to this path, if any; never creates a binding. */
export async function discardSource(sourcePath: string): Promise<void> {
    const index = readIndex(),
        key = pathKey(sourcePath)
    const id = Object.keys(index).find((candidate) => pathKey(index[candidate]) === key)
    if (id) await removeProblem(id)
}
export async function removeProblem(id: string): Promise<void> {
    const dir = directoryForId(id)
    return lockedId(dir, async () => {
        assertIdle(dir)
        // directoryForId validates the only variable path segment before recursive removal.
        await fs.rm(dir, { recursive: true, force: true })
        const index = readIndex()
        delete index[id]
        writeIndex(index)
    })
}
