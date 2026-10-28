import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { atomicCopy, atomicWrite, publishExclusive } from './atomic'

interface Journal {
    version: 1
    phase: 'prepared' | 'committed'
    before: string | null
    after: string
    added: string[]
    retired: string[]
    replaced?: { file: string; before: string | null; after: string }[]
}
export interface ImportTransaction {
    root: string
    stage: string
    id: string
}
export interface TransactionRecovery {
    retired: Set<string>
    warnings: string[]
}
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'
const stagedName = /^\.import-([a-f0-9-]{36})$/
const testPath = /^tests\/[\w-]{1,128}\.(?:in|ans)$/

async function bytes(file: string): Promise<Buffer | undefined> {
    try {
        return await fs.readFile(file)
    } catch (error) {
        if (absent(error)) return undefined
        throw error
    }
}
async function safeFile(root: string, relative: string): Promise<string> {
    if (
        !/^(?:tests\/[\w-]{1,128}\.(?:in|ans)|judge\/import-[a-f0-9-]{36}-(?:checker|interactor)\.(?:cpp|exe))$/.test(
            relative
        )
    )
        throw new Error('导入事务包含不安全文件路径')
    let current = root
    for (const part of relative.split('/')) {
        current = path.join(current, part)
        try {
            if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('导入事务路径不能包含符号链接')
        } catch (error) {
            if (!absent(error)) throw error
        }
    }
    return current
}
function parseJournal(raw: Buffer, id: string): Journal {
    const value = JSON.parse(raw.toString('utf8')) as Journal
    const hash = (item: unknown): boolean => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item)
    const added = (name: unknown): boolean =>
        typeof name === 'string' &&
        (new RegExp(`^tests/import-${id}-[0-9]+\\.(?:in|ans)$`).test(name) ||
            new RegExp(`^judge/import-${id}-(?:checker|interactor)\\.(?:cpp|exe)$`).test(name))
    if (
        !value ||
        value.version !== 1 ||
        !['prepared', 'committed'].includes(value.phase) ||
        !(value.before === null || hash(value.before)) ||
        !hash(value.after) ||
        !Array.isArray(value.added) ||
        !value.added.every(added) ||
        new Set(value.added).size !== value.added.length ||
        !Array.isArray(value.retired) ||
        !value.retired.every((name) => typeof name === 'string' && testPath.test(name)) ||
        value.retired.some((name) => value.added.includes(name)) ||
        (value.replaced !== undefined &&
            (!Array.isArray(value.replaced) ||
                value.replaced.some(
                    (item) =>
                        !item ||
                        !testPath.test(item.file) ||
                        !(item.before === null || hash(item.before)) ||
                        !hash(item.after) ||
                        value.added.includes(item.file) ||
                        value.retired.includes(item.file)
                ) ||
                new Set(value.replaced.map((item) => item.file)).size !== value.replaced.length))
    )
        throw new Error('导入事务日志格式无效；已保留全部文件')
    return value
}

export async function createImportTransaction(root: string): Promise<ImportTransaction> {
    const id = randomUUID(),
        stage = path.join(root, `.import-${id}`)
    await fs.mkdir(root, { recursive: true })
    await fs.mkdir(stage)
    return { root, stage, id }
}

/** Must be called under the problem lock, before any orphan-input reconciliation. */
export async function recoverTransactions(
    root: string,
    refresh: () => Promise<void>,
    report: (message: string) => void = console.warn
): Promise<TransactionRecovery> {
    const retired = new Set<string>(),
        warnings: string[] = []
    const entries = await fs.readdir(root, { withFileTypes: true }).catch((error) => {
        if (absent(error)) return []
        throw error
    })
    for (const entry of entries) {
        const match = stagedName.exec(entry.name)
        if (!match) continue
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('导入事务目录类型无效；已保留全部文件')
        const stage = path.join(root, entry.name),
            journalFile = path.join(stage, 'journal.json')
        const raw = await bytes(journalFile)
        // Staging did not publish anything before a complete prepared journal existed.
        if (!raw) {
            await fs.rm(stage, { recursive: true, force: true })
            continue
        }
        const journal = parseJournal(raw, match[1])
        if (journal.phase === 'prepared') {
            const current = await bytes(path.join(root, 'problem.json')),
                hash = current ? digest(current) : null
            if (hash === journal.before) {
                // Replacements keep their original bytes until the configuration commit is durable.
                // Inspect all of them first so an external edit never causes a partial rollback.
                const changed = new Set<string>()
                for (const item of journal.replaced ?? []) {
                    const currentHash = await optionalDigest(await safeFile(root, item.file))
                    if (currentHash !== item.before && currentHash !== item.after)
                        throw new Error('事务文件在提交前被外部修改；已保留全部数据和日志')
                    if (currentHash !== item.before) changed.add(item.file)
                    if (item.before !== null) {
                        if (
                            (await optionalDigest(path.join(stage, 'original', ...item.file.split('/')))) !==
                            item.before
                        )
                            throw new Error('事务恢复副本缺失或损坏；已保留全部数据和日志')
                    }
                }
                for (const item of journal.replaced ?? []) {
                    if (!changed.has(item.file)) continue
                    const target = await safeFile(root, item.file)
                    if (item.before === null) await fs.rm(target, { force: true })
                    else await atomicCopy(path.join(stage, 'original', ...item.file.split('/')), target)
                }
                for (const file of journal.added) await fs.rm(await safeFile(root, file), { force: true })
                await fs.rm(stage, { recursive: true, force: true })
                continue
            }
            if (hash !== journal.after)
                throw new Error(`无法确定导入事务是否提交；已保留全部数据和日志：${journalFile}`)
            journal.phase = 'committed'
            // Do not permit another configuration write until this decision is persisted.
            await atomicWrite(journalFile, JSON.stringify(journal))
        }
        for (const file of journal.retired) retired.add(file)
        try {
            for (const file of journal.retired) await fs.rm(await safeFile(root, file), { force: true })
            await refresh()
            await fs.rm(stage, { recursive: true, force: true })
        } catch (error) {
            const message = `题目导入已提交，清理或快照更新待重试：${(error as Error).message}`
            warnings.push(message)
            report(message)
        }
    }
    return { retired, warnings }
}

/** problem.json replacement is the commit point. No old data is removed before it. */
export async function commitImportTransaction(
    transaction: ImportTransaction,
    config: Buffer,
    added: string[],
    retired: string[],
    refresh: () => Promise<void>,
    report: (message: string) => void = console.warn,
    replaced: string[] = []
): Promise<void> {
    const { root, stage, id } = transaction
    const before = await bytes(path.join(root, 'problem.json'))
    // A content-only edit may leave identical metadata. Stamp its commit so crash recovery
    // can distinguish before/after even before the committed journal marker is written.
    config = Buffer.from(
        JSON.stringify({ ...JSON.parse(config.toString('utf8')), storageTransaction: id }, null, 2) + '\n'
    )
    const journal: Journal = {
        version: 1,
        phase: 'prepared',
        before: before ? digest(before) : null,
        after: digest(config),
        added,
        retired
    }
    if (replaced.length) {
        journal.replaced = []
        for (const file of replaced) {
            const target = await safeFile(root, file)
            let originalHash: string | null = null
            try {
                const original = path.join(stage, 'original', ...file.split('/'))
                await atomicCopy(target, original)
                // Editing is bounded by the caller's strings, but the old dataset can be large.
                // Hash the existing file through a stream rather than materializing it in memory.
                originalHash = await fileDigest(original)
            } catch (error) {
                if (!absent(error)) throw error
            }
            journal.replaced.push({
                file,
                before: originalHash,
                after: await fileDigest(path.join(stage, ...file.split('/')))
            })
        }
    }
    parseJournal(Buffer.from(JSON.stringify(journal)), id)
    if (before) await atomicWrite(path.join(stage, 'before.json'), before)
    await atomicWrite(path.join(stage, 'after.json'), config)
    await atomicWrite(path.join(stage, 'journal.json'), JSON.stringify(journal))
    let committed = false
    try {
        for (const file of added)
            await publishExclusive(path.join(stage, ...file.split('/')), await safeFile(root, file))
        for (const item of journal.replaced ?? [])
            await atomicCopy(path.join(stage, ...item.file.split('/')), await safeFile(root, item.file))
        await atomicWrite(path.join(root, 'problem.json'), config)
        committed = true
        journal.phase = 'committed'
        await atomicWrite(path.join(stage, 'journal.json'), JSON.stringify(journal))
        await recoverTransactions(root, refresh, report)
    } catch (error) {
        if (!committed) {
            // Recovery distinguishes rollback from the very small commit/marker interruption window.
            await recoverTransactions(root, refresh, report)
            throw error
        }
        report(`题目导入已提交，后续维护待重试：${(error as Error).message}`)
    }
}

async function fileDigest(file: string): Promise<string> {
    const hash = createHash('sha256')
    const handle = await fs.open(file, 'r')
    try {
        for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
        return hash.digest('hex')
    } finally {
        await handle.close()
    }
}

async function optionalDigest(file: string): Promise<string | null> {
    try {
        return await fileDigest(file)
    } catch (error) {
        if (absent(error)) return null
        throw error
    }
}
