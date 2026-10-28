import {
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { LEGACY_BRAND } from '../shared/legacyBrand'
import type { ProblemConfig } from '../shared/problem'

// These names are read only for upgrading installations predating the ITER rename.
export const LEGACY_PROFILE_NAME = 'Naven'
export const LEGACY_STORE_NAME = `.${LEGACY_BRAND}`
export const LEGACY_IDENTITY_NAME = `${LEGACY_BRAND}.id`
const migrationMarker = '.brand-migration.json'
const volatileDirectories = new Set(['cache', 'logs', 'crashDumps', 'temp', 'Cache', 'Code Cache', 'GPUCache'])
let relocatedRoots: { source: string; target: string }[] = []

/** Explicit isolated launches must never consult the user's old default directories. */
export function resetLegacyStorage(): void {
    relocatedRoots = []
}

function copyLegacyDirectory(source: string, target: string, profile = false): boolean {
    if (existsSync(target)) {
        try {
            const marker = JSON.parse(readFileSync(path.join(target, migrationMarker), 'utf8'))
            return marker.version === 1 && marker.source === source
        } catch {
            return false
        }
    }
    if (!existsSync(source)) return false
    if (!lstatSync(source).isDirectory() || lstatSync(source).isSymbolicLink())
        throw new Error(`旧数据目录类型无效，请先备份并检查：${source}`)
    const stage = path.join(path.dirname(target), `.iter-migration-${randomUUID()}`)
    mkdirSync(path.dirname(target), { recursive: true })
    try {
        cpSync(source, stage, {
            recursive: true,
            force: false,
            errorOnExist: true,
            filter: (file) => {
                const relative = path.relative(source, file)
                if (profile && relative) {
                    const first = relative.split(path.sep)[0]
                    if (volatileDirectories.has(first) || first.startsWith('Singleton')) return false
                }
                if (lstatSync(file).isSymbolicLink()) throw new Error(`旧数据包含符号链接，请先备份并检查：${file}`)
                return true
            }
        })
        if (profile) {
            const partitions = path.join(stage, 'Partitions')
            if (existsSync(partitions)) {
                const prefix = `${LEGACY_BRAND}-plugin-`
                for (const name of readdirSync(partitions)) {
                    if (!name.startsWith(prefix)) continue
                    const next = path.join(partitions, `iter-plugin-${name.slice(prefix.length)}`)
                    if (existsSync(next)) throw new Error('插件缓存目录冲突；旧数据未修改')
                    renameSync(path.join(partitions, name), next)
                }
            }
        }
        writeFileSync(path.join(stage, migrationMarker), JSON.stringify({ version: 1, source }) + '\n')
        renameSync(stage, target)
        return true
    } catch (error) {
        throw new Error(`无法将旧数据迁移到 ${target}；原目录保持不变。`, { cause: error })
    } finally {
        if (path.dirname(stage) === path.dirname(target) && path.basename(stage).startsWith('.iter-migration-'))
            rmSync(stage, { recursive: true, force: true })
    }
}

/** Copy once, publish complete directories, and never overwrite an existing ITER profile/store. */
export function migrateLegacyStorage(options: {
    appData: string
    home: string
    userData: string
    store: string
    migrateStore: boolean
}): void {
    resetLegacyStorage()
    const oldStore = path.join(options.home, LEGACY_STORE_NAME)
    if (options.migrateStore && copyLegacyDirectory(oldStore, options.store))
        relocatedRoots.push({ source: oldStore, target: options.store })
    const oldProfile = path.join(options.appData, LEGACY_PROFILE_NAME)
    if (copyLegacyDirectory(oldProfile, options.userData, true))
        relocatedRoots.push({ source: oldProfile, target: options.userData })
}

/** Translate only schema-defined paths, leaving source code and transaction journal bytes intact. */
export function relocatedLegacyPath(file: string): string {
    if (!path.isAbsolute(file)) return file
    for (const { source, target } of relocatedRoots) {
        const relative = path.relative(source, file)
        if (
            relative === '' ||
            (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
        )
            return path.join(target, relative)
    }
    return file
}

export function relocateLegacyProblem(config: ProblemConfig): ProblemConfig {
    if (!relocatedRoots.length) return config
    if (config.checker.path) config.checker.path = relocatedLegacyPath(config.checker.path)
    if (config.interactor) {
        config.interactor.path = relocatedLegacyPath(config.interactor.path)
        config.interactor.files = config.interactor.files?.map(relocatedLegacyPath)
    }
    if (config.grader) {
        config.grader.sources = config.grader.sources.map(relocatedLegacyPath)
        config.grader.includeDirs = config.grader.includeDirs?.map(relocatedLegacyPath)
    }
    for (const test of config.tests) {
        if (!test.link) continue
        test.link.input = relocatedLegacyPath(test.link.input)
        if (test.link.answer) test.link.answer = relocatedLegacyPath(test.link.answer)
    }
    if (config.cachedHeaders)
        config.cachedHeaders = Object.fromEntries(
            Object.entries(config.cachedHeaders).map(([name, target]) => [relocatedLegacyPath(name), target])
        )
    return config
}
